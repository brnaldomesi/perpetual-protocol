import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner, get } = deployments

    const clearingHouseConfig = await get("ClearingHouseConfig")
    const orderBook = await get("OrderBook")

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("AccountBalance", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: [clearingHouseConfig.address, orderBook.address],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["AccountBalance"]
