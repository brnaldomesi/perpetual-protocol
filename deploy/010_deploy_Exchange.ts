import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner, get } = deployments

    const clearingHouseConfig = await get("ClearingHouseConfig")
    const orderBook = await get("OrderBook")
    const marketRegistry = await get("MarketRegistry")

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("Exchange", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: [marketRegistry.address, orderBook.address, clearingHouseConfig.address],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["Exchange"]
