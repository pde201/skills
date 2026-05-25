#!/bin/bash
# skills/prd-lifecycle/scripts/verify-prd-closing.sh

PARENT_ID=$1

if [ -z "$PARENT_ID" ]; then
  echo "❌ Error: PARENT_ID is required! Usage: ./verify-prd-closing.sh <parent_prd_issue_id>"
  exit 1
fi

echo "=== Verifying PRD #$PARENT_ID Closing Requirements ==="

# 1. Check if all child issues linked to parent PRD are closed
echo "Checking linked child issues on GitHub..."
OPEN_CHILDREN=$(gh issue list --state open --json number,body --jq ".[] | select(.body | contains(\"#$PARENT_ID\")) | .number")

if [ ! -z "$OPEN_CHILDREN" ]; then
  echo "❌ Error: Open child issues found referencing parent PRD #$PARENT_ID:"
  echo "$OPEN_CHILDREN"
  echo "Please verify and close all child issues before closing the parent PRD."
  exit 1
fi
echo "✅ All linked child issues are closed!"

# 2. Check if docs/walkthrough.html exists
if [ ! -f "docs/walkthrough.html" ]; then
  echo "❌ Error: docs/walkthrough.html is missing!"
  exit 1
fi
echo "✅ docs/walkthrough.html is present."

# 3. Check for unstaged changes (except docs/walkthrough.html and docs/walkthrough.md)
echo "Checking Git workspace for unstaged/uncommitted files..."
UNSTAGED_FILES=$(git status --porcelain | grep -v "docs/walkthrough")
if [ ! -z "$UNSTAGED_FILES" ]; then
  echo "⚠️ Warning: You have unstaged or modified files in your directory:"
  echo "$UNSTAGED_FILES"
  echo "Please commit/stash or clean them before finalizing."
  exit 1
fi
echo "✅ Git workspace is clean."

# 4. Run TypeScript checks
echo "Running TypeScript typecheck..."
cd dashboard
npx tsc --noEmit
if [ $? -ne 0 ]; then
  echo "❌ Error: TypeScript typecheck failed!"
  exit 1
fi
echo "✅ TypeScript compilation verified clean."

# 5. Run unit tests
echo "Running Unit Tests..."
npm run test -- --watch=false
if [ $? -ne 0 ]; then
  echo "❌ Error: Unit tests failed!"
  exit 1
fi
echo "✅ All unit tests passed."

echo "🎉 All checks passed! Ready to close the parent PRD ticket."
exit 0
