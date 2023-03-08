import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner } = deployments

    const { deployer } = await getNamedAccounts()

    const cacheTwapInterval = 15 * 60

    await catchUnknownSigner(
        deploy("ChainlinkPriceFeedV2", {
            from: deployer,
            args: ["0x779877A7B0D9E8603169DdbD7836e478b4624789", cacheTwapInterval],
            log: true,
        }),
    )
}
export default func
func.tags = ["ChainlinkPriceFeedV2"]
