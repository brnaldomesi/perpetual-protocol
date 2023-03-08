import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner } = deployments

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("QuoteToken", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: ["USD", "USD"],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["QuoteToken"]
