import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner, get } = deployments

    const clearingHouseConfig = await get("ClearingHouseConfig")
    const insuranceFund = await get("InsuranceFund")
    const accountBalance = await get("AccountBalance")
    const exchange = await get("Exchange")

    const { deployer } = await getNamedAccounts()

    await catchUnknownSigner(
        deploy("Vault", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: [
                            insuranceFund.address,
                            clearingHouseConfig.address,
                            accountBalance.address,
                            exchange.address,
                        ],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["Vault"]
