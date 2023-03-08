import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { parseUnits } from "ethers/lib/utils"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner, get } = deployments

    const clearingHouseConfig = await get("ClearingHouseConfig")
    const vault = await get("Vault")
    const quoteToken = await get("QuoteToken")
    const exchange = await get("Exchange")
    const accountBalance = await get("AccountBalance")
    const insuranceFund = await get("InsuranceFund")

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("ClearingHouse", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: [
                            clearingHouseConfig.address,
                            vault.address,
                            quoteToken.address,
                            "0x1F98431c8aD98523631AE4a59f267346ea31F984",
                            exchange.address,
                            accountBalance.address,
                            insuranceFund.address,
                        ],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["ClearingHouse"]
