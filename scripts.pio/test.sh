#!/bin/bash -e

if ! hash pio 2>/dev/null; then
	echo "'pio' command not found on path!"
	echo '<wf name="result">{"success": false}</wf>'
	exit 1
fi

pio -h

echo '<wf name="result">{"success": true}</wf>'

exit 0
