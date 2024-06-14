import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { AutomateSDK, TriggerType } from "@gelatonetwork/automate-sdk";
import { Web3FunctionBuilder } from "@gelatonetwork/web3-functions-sdk/builder";
import { Contract } from "@ethersproject/contracts";
import dotenv from "dotenv";
import path from "path";
dotenv.config();

if (!process.env.PRIVATE_KEY) throw new Error("Missing env PRIVATE_KEY");
const pk = process.env.PRIVATE_KEY;

if (!process.env.PROVIDER_URLS) throw new Error("Missing env PROVIDER_URLS");
const providerUrl = process.env.PROVIDER_URLS.split(",")[0];

const MAX_RANGE = 1000; // limit range of events to comply with rpc providers
const MAX_REQUESTS = 100; // limit number of requests on every execution to avoid hitting timeout
const SWAPPER_ENGINE_ABI = ["event Deposit(address indexed requester, uint256 indexed orderId, uint256 amount)"];
const DAO_COLLATERAL_ABI = ["function swapRWAtoStbc(address rwaToken, uint256 amountInTokenDecimals, bool partialMatching, uint256[] calldata orderIdsToTake, (uint256 deadline, uint8 v, bytes32 r, bytes32 s) approval)"];

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { userArgs, storage, multiChainProvider } = context;

  const provider = multiChainProvider.default();

  // Create Swapper Engine event contract
  const swapperEngineAddress = userArgs.swapperEngine as string;
  const daoCollateralAddress = userArgs.daoCollateral as string;
  const swapperEngine = new Contract(swapperEngineAddress, SWAPPER_ENGINE_ABI, provider);
  const daoCollateral = new Contract(daoCollateralAddress, DAO_COLLATERAL_ABI, provider);
  const topics = [swapperEngine.interface.getEventTopic("Deposit")];
  const currentBlock = await provider.getBlockNumber();

  // Retrieve last processed block number & nb events matched from storage
  const lastBlockStr = await storage.get("lastBlockNumber");
  let lastBlock = lastBlockStr ? parseInt(lastBlockStr) : currentBlock - 1000;
  let totalEvents = parseInt((await storage.get("totalEvents")) ?? "0");
  console.log(`Last processed block: ${lastBlock}`);
  console.log(`Total events matched: ${totalEvents}`);

  // Fetch recent logs in range of 100 blocks
  const logs: Log[] = [];
  let nbRequests = 0;
  while (lastBlock < currentBlock && nbRequests < MAX_REQUESTS) {
    nbRequests++;
    const fromBlock = lastBlock + 1;
    const toBlock = Math.min(fromBlock + MAX_RANGE, currentBlock);
    console.log(`Fetching log events from blocks ${fromBlock} to ${toBlock}`);
    try {
      const eventFilter = {
        address: swapperEngineAddress,
        topics,
        fromBlock,
        toBlock,
      };
      const result = await provider.getLogs(eventFilter);
      logs.push(...result);
      lastBlock = toBlock;
    } catch (err) {
      return { canExec: false, message: `Rpc call failed: ${err.message}` };
    }
  }

  let rtnId = 0;
  let rtnAmount = 0;
  // Parse retrieved events
  console.log(`Matched ${logs.length} new events`);
  const nbNewEvents = logs.length;
  totalEvents += logs.length;
  for (const log of logs) {
    const event = swapperEngine.interface.parseLog(log);
    const [requester, orderId, amount] = event.args;
    rtnId = orderId;
    rtnAmount = amount;
    console.log(
      `Event Found: requester ${requester}, orderId: ${orderId}, amount ${amount} `
    );
  }

  // Update storage for next run
  await storage.set("lastBlockNumber", currentBlock.toString());
  await storage.set("totalEvents", totalEvents.toString());

  if (nbNewEvents === 0) {
    return {
      canExec: false,
      message: `Total events matched: ${totalEvents} (at block #${currentBlock.toString()})`,
    };
  }

  const orderIdsToTake: number[] = [rtnId];

  const blockTimestamp: any = (await provider.getBlock(currentBlock)).timestamp;

  const approval: [number, number, string, string] = [
    blockTimestamp + 3600, // deadline
    27, // v
    "0x1234567890123456789012345678901234567890123456789012345678901234", // r
    "0x2345678901234567890123456789012345678901234567890123456789012345" // s
  ];
  const partialMatching: boolean = false; // Replace with actual value

  // Increase number of events matched on our OracleCounter contract
  return {
    canExec: true,
    callData: [
      {
        to: daoCollateralAddress,
        data: daoCollateral.interface.encodeFunctionData("swapRWAtoStbc", [
          "0x2345678901234567890123456789012345678901", // rwaToken, replace with actual value
          rtnAmount, // amountInTokenDecimals
          partialMatching, // partialMatching
          orderIdsToTake, // orderIdsToTake
          approval // approval tuple
        ]),
      }
    ],
  };
});
