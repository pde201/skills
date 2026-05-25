#!/bin/bash
# skills/prd-lifecycle/scripts/verify-prd-closing.sh

echo "=== Verifying PRD Closing Requirements ==="

# 1. Check if docs/walkthrough.html exists and is staged/committed
if [ ! -f "docs/walkthrough.html" ]; then
  echo "❌ Error: docs/walkthrough.html is missing!"
  exit 1
fi

# 2. Run TypeScript checks
cd dashboard
npx tsc --noEmit
if [ $? -ne 0 ]; then
  echo "❌ Error: TypeScript typecheck failed!"
  exit 1
fi

# 3. Run unit tests
npm run test -- --watch=false
if [ $? -ne 0 ]; then
  echo "❌ Error: Unit tests failed!"
  exit 1
fi

echo "✅ All checks passed! Ready to close the parent PRD ticket."
exit 0
