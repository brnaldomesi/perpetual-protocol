import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { AccountBalance, BaseToken, OrderBook, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse maker close position", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let baseToken2: BaseToken
    let mockedBaseAggregator2: MockContract
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        baseToken2 = fixture.baseToken2
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, undefined, 0)
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(initPrice, 6), 0, 0, 0]
        })

        lowerTick = minTick
        upperTick = maxTick

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
    })

    // https://docs.google.com/spreadsheets/d/1kjs6thR9hXP2CCgn9zDcQESV5sWWumWIsKjBKJJC7Oc/edit#gid=574020995
    it("bob long, maker remove and close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact input (quote)
            amount: parseEther("250"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // maker remove liquidity position
        const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        // positionSize: -1983967935871743488
        const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
        // maker should settle maker position to taker position
        expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(posSize)

        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: false,
            oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // available + earned fee - debt = (124.75 - 31.75 - 0.32) + (2.5 * 10%) - 100 = -7.07
        const [aliceOwedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
        expect(aliceOwedPnl).to.closeTo(parseEther("-7.069408740359897192"), 1)
        expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq("0")
    })

    it("bob long, maker remove, reduce half then close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact input (quote)
            amount: parseEther("250"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // maker remove liquidity position
        const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity: liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        {
            // maker reduce half position
            const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
                amount: posSize.div(2).abs().toString(),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // include pnl, collectedFee and fundingPayment
            const [aliceOwedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
            expect(aliceOwedPnl).to.closeTo(parseEther("-3.186153358681875804"), 1)
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(posSize.div(2))
        }

        // maker close the remain half position, the pnl should be the same
        const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: false,
            oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
        const [aliceOwedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
        expect(aliceOwedPnl).closeTo(parseEther("-7.069408740359897191"), 3)
        expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq("0")
    })

    it("bob short, maker close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("25"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // maker remove liquidity position
        const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // available + earned fee - debt = (80 - -15.65 - 0.16) + (2 * 10%) - 100 = -4.3043478260869
        const [aliceOwedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
        expect(aliceOwedPnl).deep.eq(parseEther("-4.304347826086956531"))
    })

    describe("maker for more than 1 market", () => {
        beforeEach(async () => {
            // init BTC pool
            const initPrice = "10"
            await initMarket(fixture, initPrice, undefined, 0, undefined, baseToken2.address)
            mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits(initPrice, 6), 0, 0, 0]
            })

            // alice add liquidity to BTC
            await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
            await deposit(alice, vault, 1000, collateral)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("10"),
                quote: parseEther("100"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
            await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("90"),
                quote: parseEther("900"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("bob long, maker remove and close", async () => {
            // bob long
            await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
            await deposit(bob, vault, 250, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // maker remove liquidity position
            const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            const liquidity = order.liquidity
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // maker close position
            const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
                amount: posSize.abs().toString(),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // should be same as the situation when adding liquidity in 1 pool
            const [aliceOwedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
            expect(aliceOwedPnl).to.closeTo(parseEther("-7.069408740359897192"), 1)
        })

        it("bob short, maker close", async () => {
            // bob long
            await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
            await deposit(bob, vault, 250, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // maker remove liquidity position
            const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            const liquidity = order.liquidity
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // maker close position
            const posSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact output (base)
                amount: posSize.abs().toString(),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // should be same as the situation when adding liquidity in 1 pool
            const [aliceOwedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
            expect(aliceOwedPnl).deep.eq(parseEther("-4.304347826086956531"))
        })
    })
})
