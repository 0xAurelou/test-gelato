import { Log } from "@ethersproject/providers";
import { Web3Function, Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk";
import { Contract } from "@ethersproject/contracts";
import { ethers } from "ethers";

const MAX_RANGE = 1000; // limit range of events to comply with rpc providers
const MAX_REQUESTS = 100; // limit number of requests on every execution to avoid hitting timeout
const SWAPPER_ENGINE_ABI = [
  "event Deposit(address indexed requester, uint256 indexed orderId, uint256 amount)"
];
const DAO_COLLATERAL_ABI = [
  "function swapRWAtoStbcIntent(uint256[] orderIdsToTake, (uint256 deadline, uint8 v, bytes32 r, bytes32 s) approval, (address recipient, address rwaToken, uint256 amountInTokenDecimals, uint256 deadline, bytes signature) intent, bool partialMatching)"
];

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
  let rtnAmount = ethers.BigNumber.from(0);
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

  const approval: any = {
    deadline: blockTimestamp + 3600, // Replace with actual value
    v: 27, // Replace with actual value
    r: "0x1234567890123456789012345678901234567890123456789012345678901234", // Replace with actual value
    s: "0x2345678901234567890123456789012345678901234567890123456789012345" // Replace with actual value
  };
  const intent: any = {
    recipient: "0x1234567890123456789012345678901234567890", // Replace with actual value
    rwaToken: "0x2345678901234567890123456789012345678901", // Replace with actual value
    amountInTokenDecimals: rtnAmount, // Replace with actual value
    deadline: blockTimestamp + 3600, // Replace with actual value
    signature: "0x1234567890123456789012345678901234567890123456789012345678901234" // Replace with actual value
  };
  const partialMatching: boolean = false; // Replace with actual value

  // Increase number of events matched on our OracleCounter contract
  return {
    canExec: true,
    callData: [
      {
        to: daoCollateralAddress,
        data: daoCollateral.interface.encodeFunctionData("swapRWAtoStbcIntent", [orderIdsToTake, approval, intent, partialMatching]),
      }
    ],
  };
});
