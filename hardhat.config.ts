import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-waffle"
import "@openzeppelin/hardhat-upgrades"
import "@typechain/hardhat"
import dotenv from "dotenv"
import "hardhat-contract-sizer"
import "hardhat-dependency-compiler"
import "hardhat-deploy"
import "hardhat-gas-reporter"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"
import "./mocha-test"

dotenv.config()

const GOERLI_KEY = process.env.GOERLI_KEY || "sample-goerli-key"
const PRIVATE_KEY = process.env.PRIVATE_KEY || "sample-private-key"
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "sample-etherscan-api-key"

const config: HardhatUserConfig = {
    solidity: {
        version: "0.7.6",
        settings: {
            optimizer: { enabled: true, runs: 100 },
            evmVersion: "berlin",
            // for smock to mock contracts
            outputSelection: {
                "*": {
                    "*": ["storageLayout"],
                },
            },
        },
    },
    namedAccounts: {
        deployer: 0,
    },
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
        },
        goerli: {
            url: `https://eth-goerli.g.alchemy.com/v2/${GOERLI_KEY}`,
            accounts: [PRIVATE_KEY],
            verify: {
                etherscan: {
                    apiKey: ETHERSCAN_API_KEY,
                },
            },
        },
    },
    dependencyCompiler: {
        // We have to compile from source since UniswapV3 doesn't provide artifacts in their npm package
        paths: [
            "@uniswap/v3-core/contracts/UniswapV3Factory.sol",
            "@uniswap/v3-core/contracts/UniswapV3Pool.sol",
            "@perp/perp-oracle-contract/contracts/ChainlinkPriceFeedV2.sol",
            "@perp/perp-oracle-contract/contracts/BandPriceFeed.sol",
            "@perp/perp-oracle-contract/contracts/EmergencyPriceFeed.sol",
        ],
    },
    contractSizer: {
        // max bytecode size is 24.576 KB
        alphaSort: true,
        runOnCompile: true,
        disambiguatePaths: true,
        except: ["@openzeppelin/", "@uniswap/", "@perp/perp-oracle-contract/", "test/"],
    },
    gasReporter: {
        excludeContracts: ["test"],
    },
    mocha: {
        require: ["ts-node/register/files"],
        jobs: 4,
        timeout: 120000,
        color: true,
    },
}

export default config
