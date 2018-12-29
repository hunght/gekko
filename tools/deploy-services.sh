#!/bin/bash

DIRNAME="$(dirname "$0")"
BUILD_DIR="$DIRNAME/../"
REMOTE_DIR="/home/gekko/gekko-source"

. $DIRNAME/remote.sh

echo $DIRNAME
echo $BUILD_DIR
echo $REMOTE_DIR

rsync -aP --delete $BUILD_DIR $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR
