#!/bin/bash
# Replace João's absolute paths in all .md files with a new base path.
# Usage: ./fix_paths.sh [new_base_path]
#   new_base_path: defaults to the directory containing this script (project root)

JOAO_BASE="/Users/joaorulff/Workspace/autark-experiments/autark-experiments"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -n "$1" ]; then
    NEW_BASE="$1"
else
    NEW_BASE="$SCRIPT_DIR"
fi

echo "Replacing:"
echo "  FROM: $JOAO_BASE"
echo "  TO:   $NEW_BASE"
echo ""

find "$SCRIPT_DIR" -name "*.md" -not -path "*/.git/*" | while read -r file; do
    if grep -q "$JOAO_BASE" "$file"; then
        sed -i "s|$JOAO_BASE|$NEW_BASE|g" "$file"
        echo "Updated: $file"
    fi
done

echo ""
echo "Done."
