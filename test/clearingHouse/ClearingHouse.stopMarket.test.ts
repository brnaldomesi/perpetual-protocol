import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { ContractReceipt } from "@ethersproject/contracts"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput, q2bExactOutput, removeOrder } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { filterLogs } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("Clearinghouse StopMarket", async () => {
    const [admin, alice, bob, carol, liquidator] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let accountBalance: TestAccountBalance
    let insuranceFund: InsuranceFund
    let marketRegistry: MarketRegistry
    let exchange: TestExchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number

    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        clearingHouseConfig = fixture.clearingHouseConfig
        accountBalance = fixture.accountBalance as TestAccountBalance
        insuranceFund = fixture.insuranceFund as InsuranceFund
        orderBook = fixture.orderBook
        exchange = fixture.exchange as TestExchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        mockedBaseAggregator = fixture.mockedBaseAggregator
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        pool = fixture.pool
        pool2 = fixture.pool2
        collateralDecimals = await collateral.decimals()

        const initPrice = "151.3733069"
        await initMarket(fixture, initPrice, undefined, 0)
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        const { maxTick, minTick } = await initMarket(fixture, initPrice, undefined, 0, undefined, baseToken2.address)
        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        lowerTick = minTick
        upperTick = maxTick

        await clearingHouseConfig.setMaxFundingRate(1000000)

        // mint
        collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        collateral.mint(bob.address, parseUnits("10000", collateralDecimals))
        collateral.mint(carol.address, parseUnits("10000", collateralDecimals))
        collateral.mint(liquidator.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)
        await deposit(bob, vault, 10000, collateral)
        await deposit(carol, vault, 10000, collateral)
        await deposit(liquidator, vault, 10000, collateral)

        // maker add liquidity
        await addOrder(fixture, alice, 50, 5000, lowerTick, upperTick, false, baseToken.address)
        await addOrder(fixture, alice, 50, 5000, lowerTick, upperTick, false, baseToken2.address)

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        await initiateBothTimestamps(clearingHouse)
    })

    async function pauseMarket(baseToken: BaseToken) {
        await baseToken.pause()
        // forward both timestamps to avoid timestamps fetched later are earlier than when paused
        await forwardBothTimestamps(clearingHouse, 100)
    }

    async function closeMarket(baseToken: BaseToken, closedPrice: number) {
        await baseToken["close(uint256)"](parseEther(closedPrice.toString()))
        await forwardBothTimestamps(clearingHouse)
    }

    describe("# pause market", async () => {
        beforeEach(async () => {
            // bob open a long position
            await q2bExactInput(fixture, bob, 10, baseToken.address)

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100", 6), 0, 0, 0]
            })
        })

        it("force error, can not operate in paused market", async () => {
            await pauseMarket(baseToken)

            // can't open position
            await expect(q2bExactInput(fixture, bob, 10, baseToken.address)).to.be.revertedWith("CH_MNO")

            // can't close position
            await expect(closePosition(fixture, bob, 0, baseToken.address)).to.be.revertedWith("CH_MNO")

            // can't add liquidity
            await expect(
                addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken.address),
            ).to.be.revertedWith("CH_MNO")

            // can't remove liquidity
            await expect(removeOrder(fixture, alice, 0, lowerTick, upperTick, baseToken.address)).to.be.revertedWith(
                "CH_MP",
            )
        })

        it("can query unrealized pnl in paused market", async () => {
            await pauseMarket(baseToken)

            const [, unrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
            expect(unrealizedPnl).not.eq("0")
        })

        describe("funding payment", async () => {
            beforeEach(async () => {
                // bob open long position
                for (let i = 0; i < 3; i++) {
                    await q2bExactInput(fixture, bob, 10 + i * 5, baseToken.address)
                    await forwardBothTimestamps(clearingHouse, 5 * 60)
                }

                await pauseMarket(baseToken)
            })

            it("fundingPayment should not change anymore in paused market", async () => {
                const pendingFundingPayment1 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).not.eq("0")

                // forward 5 mins
                await forwardBothTimestamps(clearingHouse, 5 * 60)
                const pendingFundingPayment2 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment2)

                // forward 30 mins which is more than the twap interval
                await forwardBothTimestamps(clearingHouse, 30 * 60)
                const pendingFundingPayment3 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment3)

                // forward 7 days = 7 * 24 * 60 * 60
                await forwardBothTimestamps(clearingHouse, 604800)
                const pendingFundingPayment4 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment4)
            })

            it("should be able to settle funding", async () => {
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                const [owedRealizedBefore] = await accountBalance.getPnlAndPendingFee(bob.address)

                await clearingHouse.connect(bob).settleAllFunding(bob.address)

                // free collateral unchanged, owedRealizedPnl and pendingFundingPayment are being settled
                const [owedRealizedAfter] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(owedRealizedAfter.sub(owedRealizedBefore).mul(-1)).to.be.eq(pendingFundingPayment)
            })
        })

        describe("check free collateral", async () => {
            it("bob as a taker and has profit", async () => {
                // take a long position on baseToken2 with 10 quoteToken
                await q2bExactInput(fixture, bob, 10, baseToken2.address)

                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("1000", 6), 0, 0, 0]
                })
                await pauseMarket(baseToken)

                // accountValue: 10055.1280557316, totalCollateralValue: 10000
                // freeCollateral = 10000 - 20(quote debt) * 0.1 = 9998
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralBefore).to.be.closeTo(
                    parseUnits("9998", collateralDecimals).sub(pendingFundingPayment.div(1e12)),
                    parseUnits("0.001", collateralDecimals).toNumber(), // there is some imprecision
                )
            })

            it("bob as a taker and has loss", async () => {
                // bob takes a long position on baseToken2 with 100 quoteToken
                await q2bExactInput(fixture, bob, 100, baseToken2.address)

                // make profit on baseToken market
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("200", 6), 0, 0, 0]
                })

                // set a lower price to have loss on baseToken2 market
                mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("50", 6), 0, 0, 0]
                })

                await forwardBothTimestamps(clearingHouse, 100)

                await pauseMarket(baseToken2)

                // accountValue: 9935.119361, totalCollateralValue: 10000
                // freeCollateral = 9935.119361 - 110(quote debt) * 0.1 = 9924.119361
                const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralBefore).to.be.closeTo(
                    parseUnits("9924.119361", collateralDecimals),
                    parseUnits("0.15", collateralDecimals).toNumber(), // there is some imprecision
                )
            })
        })

        describe("accounting", async () => {
            beforeEach(async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)

                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("50", 6), 0, 0, 0]
                })

                await pauseMarket(baseToken)
            })

            it("unrealized pnl accounting", async () => {
                const bobStoppedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const bobStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const [, bobUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

                // TODO: why don't we use getTotalPositionValue here?
                expect(bobUnrealizedPnl).to.be.eq(
                    bobStoppedMarketPositionSize.mul("50").add(bobStoppedMarketQuoteBalance),
                )

                const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    alice.address,
                    baseToken.address,
                )
                const aliceStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    alice.address,
                    baseToken.address,
                )
                const [, aliceUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)

                expect(aliceUnrealizedPnl).to.be.closeTo(
                    aliceStoppedMarketPositionSize.mul("50").add(aliceStoppedMarketQuoteBalance),
                    1,
                )
            })

            it("total position value accounting", async () => {
                const bobStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const bobStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
                    bob.address,
                    baseToken.address,
                )

                const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    alice.address,
                    baseToken.address,
                )
                const aliceStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
                    alice.address,
                    baseToken.address,
                )

                expect(bobStoppedMarketPositionValue).to.be.eq(bobStoppedMarketPositionSize.mul("50"))
                expect(aliceStoppedMarketPositionValue).to.be.eq(aliceStoppedMarketPositionSize.mul("50"))
            })
        })
    })

    describe("# close market", async () => {
        describe("remove liquidity", async () => {
            beforeEach(async () => {
                await q2bExactOutput(fixture, bob, "0.1", baseToken.address)
                await pauseMarket(baseToken)
                await closeMarket(baseToken, 100)
            })

            it("should be able to removeLiquidity in closed market", async () => {
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                expect(liquidity).to.be.gt("0")
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                expect(await orderBook.hasOrder(alice.address, [baseToken.address])).to.be.eq(false)
            })

            it("remove liquidity and settled to taker position", async () => {
                // removeLiquidity
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)

                const positionSizeAfterClosed = await accountBalance.getTakerPositionSize(
                    alice.address,
                    baseToken.address,
                )
                expect(positionSizeAfterClosed).to.be.closeTo(parseEther("-0.1"), 1)
            })
        })

        describe("close position", async () => {
            beforeEach(async () => {
                await q2bExactOutput(fixture, bob, "0.1", baseToken.address)
                await pauseMarket(baseToken)
                await closeMarket(baseToken, 100)
            })

            it("force error, trader still has order in closed market, can not close position", async () => {
                await expect(clearingHouse.quitMarket(alice.address, baseToken.address)).to.be.revertedWith("CH_HOICM")
            })

            it("should be able to quitMarket after removeLiquidity in closed market", async () => {
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                expect(liquidity).to.be.gt("0")
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                expect(await orderBook.hasOrder(alice.address, [baseToken.address])).to.be.eq(false)

                await expect(clearingHouse.quitMarket(alice.address, baseToken.address)).to.be.emit(
                    clearingHouse,
                    "PositionClosed",
                )

                const positionSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
                expect(positionSize).to.be.eq(0)
            })

            it("should be able to quitMarket in closed market", async () => {
                const positionSize = await accountBalance.getTakerPositionSize(bob.address, baseToken.address)
                expect(positionSize).to.be.eq(parseEther("0.1"))

                await expect(clearingHouse.quitMarket(bob.address, baseToken.address)).to.be.emit(
                    clearingHouse,
                    "PositionClosed",
                )

                const positionSizeAfter = await accountBalance.getTotalPositionSize(bob.address, baseToken.address)
                expect(positionSizeAfter).to.be.eq(0)
            })

            it("should deregister closed market baseToken", async () => {
                await clearingHouse.quitMarket(bob.address, baseToken.address)

                const baseTokens = await accountBalance.getBaseTokens(bob.address)
                expect(baseTokens.length).to.be.eq(0)
            })
        })

        describe("PnL accounting after close position", async () => {
            beforeEach(async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)
                await q2bExactInput(fixture, bob, 10, baseToken2.address)

                await pauseMarket(baseToken)
            })

            it("taker has positive pnl in closed market", async () => {
                await closeMarket(baseToken, 1000)

                // taker settle on closed market
                const closedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const closedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                const expectedPnl = closedMarketPositionSize.mul("1000").add(closedMarketQuoteBalance)

                await expect(clearingHouse.quitMarket(bob.address, baseToken.address))
                    .to.emit(accountBalance, "PnlRealized")
                    .withArgs(bob.address, expectedPnl)

                const [takerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(takerOwedRealizedPnl).to.be.closeTo(
                    expectedPnl.sub(pendingFundingPayment),
                    parseEther("0.00001").toNumber(), // there is some imprecision
                )

                // maker settle on closed market
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                await clearingHouse.quitMarket(alice.address, baseToken.address)

                const [makerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
                expect(makerOwedRealizedPnl).to.be.closeTo(takerOwedRealizedPnl.mul("-1"), 1010) // there is some imprecision
            })

            it("taker has negative pnl in closed market", async () => {
                await closeMarket(baseToken, 50)

                const closedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const closedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                const expectedPnl = closedMarketPositionSize.mul("50").add(closedMarketQuoteBalance)

                await expect(clearingHouse.quitMarket(bob.address, baseToken.address))
                    .to.emit(accountBalance, "PnlRealized")
                    .withArgs(bob.address, expectedPnl)

                const [takerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(takerOwedRealizedPnl).to.be.closeTo(
                    expectedPnl.sub(pendingFundingPayment),
                    parseEther("0.00001").toNumber(), // there is some imprecision
                )

                // maker settle on closed market
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                await clearingHouse.quitMarket(alice.address, baseToken.address)

                const [makerOwedRealizedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
                // there is some imprecision of about 1 wei * 50
                expect(makerOwedRealizedPnl).to.be.closeTo(takerOwedRealizedPnl.mul("-1"), 60) // there is some imprecision
            })
        })

        describe("check free collateral and withdrawal after stopping market", async () => {
            it("taker has positive pnl on closed market", async () => {
                // take long positions on both baseToken and baseToken2 with 10 quoteToken
                await q2bExactInput(fixture, bob, 10, baseToken.address)
                await q2bExactInput(fixture, bob, 10, baseToken2.address)

                await pauseMarket(baseToken)
                await closeMarket(baseToken, 1000)

                // accountValue: 10055.1280557316, totalCollateralValue: 10000
                // freeCollateral = 10000 - 20(quote debt) * 0.1 = 9998
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralBefore).to.be.closeTo(
                    parseUnits("9998", collateralDecimals).sub(pendingFundingPayment.div(1e12)),
                    parseUnits("0.02", collateralDecimals).toNumber(), // there is some imprecision
                )

                // taker settle on closed market
                await clearingHouse.quitMarket(bob.address, baseToken.address)

                // closedMarketPositionSize: 0.065271988421256964, closedMarketQuoteBalance: -10
                // accountValue: 10055.128040, totalCollateralValue: 10000 + closedMarketPositionSize.mul("1000").add(closedMarketQuoteBalance) = 10055.271969
                // freeCollateral = 10055.128040 - 1 = 10054.128040
                const freeCollateralAfter = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralAfter).to.be.closeTo(
                    parseUnits("10054.128040", collateralDecimals),
                    parseUnits("0.02", collateralDecimals).toNumber(), // there is some imprecision
                )

                // sometimes not subtracting 1 can fail
                await vault.connect(bob).withdraw(collateral.address, freeCollateralAfter.sub(1))
                expect(await vault.getFreeCollateral(bob.address)).to.be.closeTo("0", 1)
            })

            it("taker has negative pnl on closed market", async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)
                await q2bExactInput(fixture, bob, 100, baseToken2.address)

                // make profit on baseToken market
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("200", 6), 0, 0, 0]
                })

                await pauseMarket(baseToken2)
                await closeMarket(baseToken2, 50)

                // accountValue: 9935.120694, totalCollateralValue: 10000
                // freeCollateral = 9935.120694 - 11 = 9924.120694
                const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralBefore).to.be.closeTo(
                    parseUnits("9924.120694", collateralDecimals),
                    parseUnits("0.02", collateralDecimals).toNumber(), // there is some imprecision
                )

                // taker settle on closed market
                await clearingHouse.quitMarket(bob.address, baseToken2.address)

                // closedMarketPositionSize: 0.6413142475, closedMarketQuoteBalance: -100
                // accountValue: 9935.066296, totalCollateralValue: 10000 + closedMarketPositionSize.mul("50").add(closedMarketQuoteBalance) = 9932.066296
                // freeCollateral = 9932.066296 - 1 = 9931.066296
                const freeCollateralAfter = await vault.getFreeCollateral(bob.address)
                expect(freeCollateralAfter).to.be.closeTo(
                    parseUnits("9931.066296", collateralDecimals),
                    parseUnits("0.02", collateralDecimals).toNumber(), // there is some imprecision
                )

                await vault.connect(bob).withdraw(collateral.address, freeCollateralAfter)
                expect(await vault.getFreeCollateral(bob.address)).to.be.closeTo("0", 1)
            })
        })

        describe("accounting in closed market", async () => {
            beforeEach(async () => {
                // open position on two market
                await q2bExactInput(fixture, bob, 10, baseToken.address)

                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("100", 6), 0, 0, 0]
                })

                await pauseMarket(baseToken)
                await closeMarket(baseToken, 50)
            })

            it("unrealized pnl accounting", async () => {
                const bobStoppedMarketPositionSize = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const bobStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const [, bobUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

                expect(bobUnrealizedPnl).to.be.eq(
                    bobStoppedMarketPositionSize.mul("50").add(bobStoppedMarketQuoteBalance),
                )

                const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const aliceStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
                    bob.address,
                    baseToken.address,
                )
                const [, aliceUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

                expect(aliceUnrealizedPnl).to.be.eq(
                    aliceStoppedMarketPositionSize.mul("50").add(aliceStoppedMarketQuoteBalance),
                )
            })

            it("total position value accounting", async () => {
                const bobStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const bobStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
                    bob.address,
                    baseToken.address,
                )

                const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
                    alice.address,
                    baseToken.address,
                )
                const aliceStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
                    alice.address,
                    baseToken.address,
                )

                expect(bobStoppedMarketPositionValue).to.be.eq(bobStoppedMarketPositionSize.mul("50"))
                expect(aliceStoppedMarketPositionValue).to.be.eq(aliceStoppedMarketPositionSize.mul("50"))
            })
        })

        describe("funding payment", async () => {
            beforeEach(async () => {
                for (let i = 0; i < 3; i++) {
                    await q2bExactInput(fixture, bob, 10 + i * 5, baseToken.address)
                    await forwardBothTimestamps(clearingHouse, 5 * 60)
                }

                await pauseMarket(baseToken)
                await closeMarket(baseToken, 50)
            })

            it("fundingPayment should not change anymore in paused market", async () => {
                const pendingFundingPayment1 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).not.eq("0")

                // forward 5 mins
                await forwardBothTimestamps(clearingHouse, 5 * 60)
                const pendingFundingPayment2 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment2)

                // forward 30 mins which is more than the twap interval
                await forwardBothTimestamps(clearingHouse, 30 * 60)
                const pendingFundingPayment3 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment3)

                // forward 7 days = 7 * 24 * 60 * 60
                await forwardBothTimestamps(clearingHouse, 604800)
                const pendingFundingPayment4 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment4)
            })

            it("should be able to settle funding", async () => {
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                const [owedRealizedBefore] = await accountBalance.getPnlAndPendingFee(bob.address)

                await clearingHouse.connect(bob).settleAllFunding(bob.address)

                const [owedRealizedAfter] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(owedRealizedAfter.sub(owedRealizedBefore).mul(-1)).to.be.eq(pendingFundingPayment)
            })
        })

        describe("realizedPnl", async () => {
            const getPositionClosedEvent = (receipt: ContractReceipt): [BigNumber, BigNumber] => {
                const logs = filterLogs(receipt, clearingHouse.interface.getEventTopic("PositionClosed"), clearingHouse)
                let realizedPnl = BigNumber.from(0)
                let positionNotional = BigNumber.from(0)
                for (const log of logs) {
                    realizedPnl = realizedPnl.add(log.args.realizedPnl)
                    positionNotional = positionNotional.add(log.args.closedPositionNotional)
                }
                return [realizedPnl, positionNotional]
            }

            const getRemoveLiquidityEvent = (receipt: ContractReceipt): BigNumber => {
                const logs = filterLogs(
                    receipt,
                    clearingHouse.interface.getEventTopic("LiquidityChanged"),
                    clearingHouse,
                )
                let owedRealizedPnl = BigNumber.from(0)
                for (const log of logs) {
                    owedRealizedPnl = owedRealizedPnl.add(log.args.quoteFee)
                }
                return owedRealizedPnl
            }

            it("quitMarket when no InsuranceFundFee", async () => {
                await q2bExactInput(fixture, bob, "100", baseToken.address)

                // close market
                await pauseMarket(baseToken)
                await closeMarket(baseToken, 0.001)

                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                const tx = await (
                    await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                ).wait()
                // get maker fee
                const aliceOwedRealizedPnl = getRemoveLiquidityEvent(tx)

                const aliceTx = await (await clearingHouse.quitMarket(alice.address, baseToken.address)).wait()
                const bobTx = await (await clearingHouse.quitMarket(bob.address, baseToken.address)).wait()

                const [aliceRealizedPnl, alicePositionNotional] = getPositionClosedEvent(aliceTx)
                const [bobRealizedPnl, bobPositionNotional] = getPositionClosedEvent(bobTx)

                const totalPositionNotional = alicePositionNotional.add(bobPositionNotional)
                // totalRealizedPnl = totalTakerRealizedPnl + totalMakerFee = 0
                const totalRealizedPnl = aliceRealizedPnl.add(aliceOwedRealizedPnl).add(bobRealizedPnl)

                expect(totalPositionNotional).to.be.eq("0")
                expect(totalRealizedPnl).to.be.closeTo("0", 2)
            })

            it("quitMarket when InsuranceFundFee", async () => {
                await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, "400000")

                await q2bExactInput(fixture, bob, "100", baseToken.address)

                // close market
                await pauseMarket(baseToken)
                await closeMarket(baseToken, 0.001)

                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                const tx = await (
                    await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                ).wait()
                // get maker fee
                const aliceOwedRealizedPnl = getRemoveLiquidityEvent(tx)

                const aliceTx = await (await clearingHouse.quitMarket(alice.address, baseToken.address)).wait()
                const bobTx = await (await clearingHouse.quitMarket(bob.address, baseToken.address)).wait()

                const [aliceRealizedPnl, alicePositionNotional] = getPositionClosedEvent(aliceTx)
                const [bobRealizedPnl, bobPositionNotional] = getPositionClosedEvent(bobTx)

                const [insuranceFundFee] = await accountBalance.getPnlAndPendingFee(insuranceFund.address)
                const totalPositionNotional = alicePositionNotional.add(bobPositionNotional)
                // totalRealizedPnl = totalTakerRealizedPnl + totalMakerFee + insuranceFundFee = 0
                const totalRealizedPnl = bobRealizedPnl
                    .add(aliceRealizedPnl)
                    .add(aliceOwedRealizedPnl)
                    .add(insuranceFundFee)

                expect(totalPositionNotional).to.be.eq("0")
                expect(totalRealizedPnl).to.be.closeTo("0", 2)
            })
        })
    })

    describe("# cancel order and liquidate", async () => {
        it("orders in paused and closed market can't be cancelled", async () => {
            // Bob has order in baseToken2 market
            await addOrder(fixture, bob, 50, 5000, lowerTick, upperTick, false, baseToken2.address)

            // should have order in open market
            expect(await accountBalance.hasOrder(bob.address)).to.be.eq(true)

            await pauseMarket(baseToken2)

            // can not cancel order in paused market
            await expect(clearingHouse.cancelAllExcessOrders(bob.address, baseToken2.address)).to.be.revertedWith(
                "CH_MNO",
            )

            await closeMarket(baseToken2, 0.0001)

            // should not have order in open market
            expect(await accountBalance.hasOrder(bob.address)).to.be.eq(false)

            // can not cancel order in closed market
            await expect(clearingHouse.cancelAllExcessOrders(bob.address, baseToken2.address)).to.be.revertedWith(
                "CH_MNO",
            )
        })

        it("position can't be liquidated if the position is in paused/closed market", async () => {
            // Bob as taker in baseToken market
            await addOrder(fixture, alice, 300, 30000, lowerTick, upperTick, false, baseToken.address)

            // Bob swaps on baseToken market, use for loop due to MaxTickCrossedWithinBlock limit
            for (let i = 0; i < 10; i++) {
                await q2bExactInput(fixture, bob, 1000, baseToken.address)
                await forwardBothTimestamps(clearingHouse, 100)
            }

            await pauseMarket(baseToken)

            // drop price on baseToken market
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0.000001", 6), 0, 0, 0]
            })
            await expect(
                clearingHouse["liquidate(address,address,int256)"](bob.address, baseToken.address, 0),
            ).to.be.revertedWith("CH_MNO")

            await closeMarket(baseToken, 0.0001)

            await expect(
                clearingHouse["liquidate(address,address,int256)"](bob.address, baseToken.address, 0),
            ).to.be.revertedWith("CH_MNO")
        })

        it("position in open market can be liquidated even if the trader has orders in other paused market", async () => {
            // alice add liquidity in baseToken market for Bob to swap
            await addOrder(fixture, alice, 300, 30000, lowerTick, upperTick, false, baseToken.address)

            // Bob add liquidity to baseToken2 market
            await addOrder(fixture, bob, 50, 5000, lowerTick, upperTick, false, baseToken2.address)

            // Bob swaps on baseToken market, use for loop due to MaxTickCrossedWithinBlock limit
            for (let i = 0; i < 10; i++) {
                await q2bExactInput(fixture, bob, 1000, baseToken.address)
                await forwardBothTimestamps(clearingHouse, 100)
            }

            await pauseMarket(baseToken2)

            // drop price on baseToken market
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0.000001", 6), 0, 0, 0]
            })

            // Bob's free collateral should be 0 if his position is underwater
            expect(await vault.getFreeCollateral(bob.address)).to.be.eq("0")

            // liquidate bob on baseToken market
            await expect(
                clearingHouse
                    .connect(liquidator)
                    ["liquidate(address,address,int256)"](bob.address, baseToken.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")
        })

        it("position in open market can be liquidated even if the trader has orders in other closed market", async () => {
            // alice add liquidity in baseToken market for Bob to swap
            await addOrder(fixture, alice, 300, 30000, lowerTick, upperTick, false, baseToken.address)

            // bob add liquidity to baseToken2 market
            await addOrder(fixture, bob, 50, 5000, lowerTick, upperTick, false, baseToken2.address)

            // Bob swaps on baseToken market, use for loop due to MaxTickCrossedWithinBlock limit
            for (let i = 0; i < 10; i++) {
                await q2bExactInput(fixture, bob, 1000, baseToken.address)
                await forwardBothTimestamps(clearingHouse, 100)
            }

            await pauseMarket(baseToken2)
            await closeMarket(baseToken2, 0.0001)

            // drop price on baseToken market
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0.000001", 6), 0, 0, 0]
            })

            // Bob's free collateral should be 0 if his position is underwater
            expect(await vault.getFreeCollateral(bob.address)).to.be.eq("0")

            // liquidate bob on baseToken market
            await expect(
                clearingHouse
                    .connect(liquidator)
                    ["liquidate(address,address,int256)"](bob.address, baseToken.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")
        })
    })
})
