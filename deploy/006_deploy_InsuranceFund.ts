import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner } = deployments

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("InsuranceFund", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: ["0x07865c6e87b9f70255377e024ace6630c1eaa37f"],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["InsuranceFund"]
