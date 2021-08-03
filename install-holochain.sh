#!/bin/bash

REV=c5dbdf28825927106bc32d186dd54f20d35df468
LAIR_REV=a01a40640574d3cfabae33dfe3f861de7bd7a57c

cargo install --force holochain \
  --git https://github.com/holochain/holochain.git \
  --rev $REV
cargo install holochain_cli --force --bin hc \
  --git https://github.com/holochain/holochain.git \
  --rev $REV
cargo install --force lair_keystore \
      --git https://github.com/holochain/lair.git \
      --rev $LAIR_REV
