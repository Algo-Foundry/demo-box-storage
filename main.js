const algosdk = require("algosdk");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// algod
const address = process.env.ALGOD_ADDR;
const port = "";
const token = JSON.parse(process.env.ALGOD_TOKEN);
const algodClient = new algosdk.Algodv2(token, address, port);

// account
const creator = algosdk.mnemonicToSecretKey(process.env.MASTER_MNEMONIC);

const submitAtomicToNetwork = async (txns) => {
  const { txn } = algosdk.decodeSignedTransaction(txns[txns.length - 1]);

  // send txn
  let tx = await algodClient.sendRawTransaction(txns).do();
  console.log("Transaction : " + tx.txId);

  // check results of very last txn
  let confirmedTxn = await algosdk.waitForConfirmation(algodClient, txn.txID(), 30);

  console.log(confirmedTxn);

  return confirmedTxn;
}

const getBasicProgramBytes = async (filename) => {
  // Read file for Teal code
  const filePath = path.join(__dirname, filename);
  const data = fs.readFileSync(filePath);

  // use algod to compile the program
  const compiledProgram = await algodClient.compile(data).do();
  return new Uint8Array(Buffer.from(compiledProgram.result, "base64"));
};

const deployApp = async () => {
  // define application parameters
  const from = creator.addr;
  const onComplete = algosdk.OnApplicationComplete.NoOpOC;
  const approvalProgram = await getBasicProgramBytes("./artifacts/sc_approval.teal");
  const clearProgram = await getBasicProgramBytes("./artifacts/sc_clearstate.teal");
  const numLocalInts = 0;
  const numLocalByteSlices = 0;
  const numGlobalInts = 1; //saves length data stored in box
  const numGlobalByteSlices = 2; //saves box data and extracted box data
  const appArgs = [];

  // get suggested params
  const suggestedParams = await algodClient.getTransactionParams().do();

  // create the application creation transaction
  const createTxn = algosdk.makeApplicationCreateTxn(
    from,
    suggestedParams,
    onComplete,
    approvalProgram,
    clearProgram,
    numLocalInts,
    numLocalByteSlices,
    numGlobalInts,
    numGlobalByteSlices,
    appArgs
  );

  const signedCreateTxn = createTxn.signTxn(creator.sk);
  const confirmedTxn = await submitAtomicToNetwork([signedCreateTxn]);
  
  // read global state
  const appId = confirmedTxn["application-index"];
  console.log("App ID:", appId);

  // fund contract with 0.1 algos
  const appAddr = algosdk.getApplicationAddress(appId); 
  await transferAlgos(appAddr, 1e5);
  
  return appId;
}

const appCall = async (sender, appId, appArgs, boxArr, assets, accounts, apps) => {
  // get suggested params
  const suggestedParams = await algodClient.getTransactionParams().do();

  // call the created application
  const data = {
    from: sender.addr,
    appIndex: appId,
    suggestedParams,
    appArgs,
  }

  if (assets.length > 0) {
    data.foreignAssets = assets;
  }

  if (apps.length > 0) {
    data.foreignApps = apps;
  }

  if (accounts.length > 0) {
    data.accounts = accounts;
  }

  if (boxArr.length > 0) {
    data.boxes = boxArr
  }

  const callTxn = algosdk.makeApplicationNoOpTxnFromObject(data);

  return callTxn;
}

const readGlobalState = async (appId) => {
  const app = await algodClient.getApplicationByID(appId).do();
  
  // global state is a key value array
  const globalState = app.params["global-state"];
  const textDecoder = new TextDecoder();
  const gsmap = new Map();
  globalState.forEach(item => {
    // decode from base64 and utf8
    const formattedKey = textDecoder.decode(Buffer.from(item.key, "base64"));

    let formattedValue;
    if (item.value.type === 1) {
      formattedValue = textDecoder.decode(Buffer.from(item.value.bytes, "base64"));
    } else {
      formattedValue = item.value.uint;
    }

    gsmap.set(formattedKey, formattedValue);
  });

  return gsmap;
}

const boxCreate = async (appId, boxName, size) => {
  // create box
  const appArgs = [
    new Uint8Array(Buffer.from("create_box")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
    algosdk.encodeUint64(size)
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, size);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  console.log(await getBoxByName(appId, boxName));
}

const boxPut = async (appId, boxName, data) => {
  // format box data
  const boxData = formatAppData(data);

  // put data in box
  const appArgs = [
    new Uint8Array(Buffer.from("box_put")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
    boxData
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, boxData.length);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  console.log(await getBoxByName(appId, boxName));
}

const boxDelete = async (appId, boxName) => {
  const thisBox = await getBoxByName(appId, boxName);

  // put data in box
  const appArgs = [
    new Uint8Array(Buffer.from("box_delete")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, thisBox.data.length);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  // print remaining boxes
  console.log("app boxes:", await getAppBoxNames(appId));
}

const boxReplaceData = async (appId, boxName, start, newData) => {
  const boxData = formatAppData(newData);
  const thisBox = await getBoxByName(appId, boxName);

  if (boxData.length >= thisBox.data.length) {
    throw new Error("End position exceeds size of the box");
  }

  if (start >= thisBox.data.length) {
    throw new Error("Start position exceeds size of the box");
  }

  const appArgs = [
    new Uint8Array(Buffer.from("box_replace")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
    algosdk.encodeUint64(start),
    boxData
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, thisBox.data.length);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  console.log(await getBoxByName(appId, boxName));
}

const boxExtract = async (appId, boxName, start, extractLen) => {
  const thisBox = await getBoxByName(appId, boxName);

  if (extractLen >= thisBox.data.length) {
    throw new Error("Extract data length is too long");
  }

  if (start >= thisBox.data.length) {
    throw new Error("Start position exceeds size of the box");
  }

  const appArgs = [
    new Uint8Array(Buffer.from("box_extract")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
    algosdk.encodeUint64(start),
    algosdk.encodeUint64(extractLen)
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, thisBox.data.length);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  console.log(await readGlobalState(appId));
}

const boxRead = async (appId, boxName) => {
  const thisBox = await getBoxByName(appId, boxName);

  const appArgs = [
    new Uint8Array(Buffer.from("box_read")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, thisBox.data.length);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  console.log(await readGlobalState(appId));
}

const boxLength = async (appId, boxName) => {
  const thisBox = await getBoxByName(appId, boxName);

  const appArgs = [
    new Uint8Array(Buffer.from("box_length")),
    new Uint8Array(Buffer.from(boxName)), // 1-64 bytes, unique for the app
  ];

  // box array
  const boxArgs = formatBoxArrayForTxn(boxName, thisBox.data.length);

  const txn = await appCall(creator, appId, appArgs, boxArgs, [], [], []);
  const signedTxn = txn.signTxn(creator.sk);
  await submitAtomicToNetwork([signedTxn]);

  console.log(await readGlobalState(appId));
}

const formatBoxArrayForTxn = (boxName, boxSize) => {
  // Each box ref in box array can only access 1K byte of box state
  console.log("box size:", boxSize);
  const slotsNeeded = Math.ceil(boxSize / 1024);
  console.log("slots needed: ", slotsNeeded);

  // 1 transaction can allow 8 slots at max
  if (slotsNeeded > 8) {
    throw new Error("Exceeded 8 slots for foreign arrays in a transaction");
  }

  // Start with name of the box
  let boxArray = [
    {
      appIndex: 0,
      name: new Uint8Array(Buffer.from(boxName))
    }
  ];

  // Empty slots
  const emptySlot = {
    appIndex: 0,
    name: new Uint8Array()
  };

  // Add empty slots
  let i = 1;
  while (i < slotsNeeded) {
    boxArray.push(emptySlot);
    i++;
  }

  // Box array ref shares the total number of objects across other arrays (8)
  console.log("box array:", boxArray);
  return boxArray;
}

const formatAppData = (data) => {
  // format box data
  let output;
  if (typeof(data) === "number") {
    output = algosdk.encodeUint64(data);
  } else {
    output = new Uint8Array(Buffer.from(data));
  }

  return output;
}

const transferAlgos = async (to, amount) => {
  console.log(`Transferring ${amount} microalgos from ${creator.addr} to ${to}`);
  const suggestedParams = await algodClient.getTransactionParams().do();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    from: creator.addr,
    to,
    amount,
    suggestedParams
  });

  const signedTxn = txn.signTxn(creator.sk);
  return await submitAtomicToNetwork([signedTxn]);
}

const contractHasAlgos = async (appId, boxName, boxSize) => {
  // if contract does not have enough balance to create box, do topup
  const appAddr = algosdk.getApplicationAddress(appId);
  const acc = await algodClient.accountInformation(appAddr).do();
  console.log(acc);

  // min balance to create box
  const minBalance = 2500 + (400 * (boxName.length + boxSize));
  console.log(`Box requires ${minBalance} microAlgos, ${minBalance / 1e6} Algos`);
  if (acc["amount"] < (acc["min-balance"] + minBalance)) {
    await transferAlgos(appAddr, minBalance);
  }
}

const getBoxByName = async (appId, boxName) => {
  const res = await algodClient.getApplicationBoxByName(appId, new Uint8Array(Buffer.from(boxName))).do();

  // format output
  return {
    name: new TextDecoder().decode(res.name),
    data: res.value,
  }
}

const getAppBoxNames = async (appId) => {
  const res = await algodClient.getApplicationBoxes(appId).do();

  const textDecoder = new TextDecoder();
  return res.boxes.map(box => {
    return textDecoder.decode(box.name)
  });
}

(async () => {
  // deploy app
  let appId;
  if (process.env.APP_ID !== "") {
    appId = Number(process.env.APP_ID);
  } else {
    appId = await deployApp();
  }

  const appAddr = algosdk.getApplicationAddress(appId);

  // Existing boxs on app
  const appBoxNames = await getAppBoxNames(appId);
  console.log("app boxes:", appBoxNames);

  // create box with defined storage size
  // const boxName = "empty_box_1";
  // const boxSize = 4 * 1024; //bytes
  // await contractHasAlgos(appId, boxName, boxSize);
  // await boxCreate(appId, boxName, boxSize);

  // using box_put to create a box with data
  // const boxName = "box_with_data";
  // const boxData = "A".repeat(100); //app args are limited to 2KB
  // const boxSize = new Uint8Array(Buffer.from(boxData)).length;
  // await contractHasAlgos(appId, boxName, boxSize);
  // await boxPut(appId, boxName, boxData);

  // delete a box
  // await boxDelete(appId, "empty_box");

  // replace data in box
  // const boxData = "B".repeat(10);
  // await boxReplaceData(appId, "box_with_data", 0, boxData);

  // Extract data from box in contract
  // await boxExtract(appId, "box_with_data", 4, 5);

  // read box data in contract
  // await boxRead(appId, "box_with_data");

  // read box length in contract
  // await boxLength(appId, "box_with_data");
})();
