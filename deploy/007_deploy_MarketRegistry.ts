import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner, get } = deployments

    const quoteToken = await get("QuoteToken")

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("MarketRegistry", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: ["0x1F98431c8aD98523631AE4a59f267346ea31F984", quoteToken.address],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["MarketRegistry"]
