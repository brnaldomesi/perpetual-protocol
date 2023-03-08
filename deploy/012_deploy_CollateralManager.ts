import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { parseUnits } from "ethers/lib/utils"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy, catchUnknownSigner, get } = deployments

    const clearingHouseConfig = await get("ClearingHouseConfig")
    const vault = await get("Vault")

    const { deployer } = await getNamedAccounts()

    const usdcDecimals = 6

    await catchUnknownSigner(
        deploy("CollateralManager", {
            from: deployer,
            proxy: {
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: [
                            clearingHouseConfig.address,
                            vault.address,
                            5, // maxCollateralTokensPerAccount
                            "750000", // debtNonSettlementTokenValueRatio
                            "500000", // liquidationRatio
                            "2000", // mmRatioBuffer
                            "30000", // clInsuranceFundFeeRatio
                            parseUnits("10000", usdcDecimals), // debtThreshold
                            parseUnits("500", usdcDecimals), // collateralValueDust
                        ],
                    },
                },
            },
            log: true,
        }),
    )
}
export default func
func.tags = ["CollateralManager"]
