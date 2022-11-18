# Box Storage Demo
This is a demo on the various functions for storage boxes. The smart contract allows users to perform app calls related to storage boxes.

The box storage functions are 

### create_box
Creates a box with a name and specified size.

### box_put
Creates a box based on the input data size and puts the data inside.

### box_replace
Replaces the data in the box from the start position of the stored byte value.

### box_read
Reads the data from the box in the contract.

### box_extract
Reads parts of the data from the box in the contract, if it is more than 4kb.

### box_length
Gets the size of the box

### box_delete
Deletes the box

The frontend `main.js` deploys the smart contract and contains functions to perform the respective app calls.

## Requirements
1. pyTEAL v0.20.1
2. algosdk v1.23.2
3. Purestake account (which connects to an Algorand Node on BetaNet)