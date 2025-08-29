# DemoSnap Tests

This directory contains Playwright tests for the DemoSnap compositor and studio functionality.

## Test Files

### `duration-fix.test.ts`

Tests specifically for the 2-second video duration issue fix:

- ✅ Verifies minimum 8-second recording duration enforcement
- ✅ Confirms video looping prevents early termination
- ✅ Validates that short `fallbackDuration` values are overridden

### `studio.test.ts`

Comprehensive integration tests for the studio server:

- ✅ Studio server startup and UI loading
- ✅ API endpoint functionality (`/api/jobs`, `/api/auto-flow`, `/api/compose`)
- ✅ Compositor initialization and readiness signaling
- ✅ Video recording duration enforcement
- ✅ Shader development panel functionality
- ✅ End-to-end video composition workflow

### `runFlow.test.ts`

Existing tests for flow execution and browser automation.

## Quick Test

For a fast verification of the 2-second fix:

```bash
node test-duration.js
```

This will output:

```
🧪 Testing video duration fix...

📋 Test Results:
   [test] Starting duration fix test
   [test] Original fallbackDuration: 2000
   [test] Enforced minimum duration: 8000
   [test] Final recording duration: 9200
   [test] Video loop enabled: true

✅ PASS: Duration fix working - recording will be 9.2 seconds
✅ PASS: Video looping enabled

🎉 All duration fix tests passed!
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:duration
npm run test:studio

# Run the quick duration test
node test-duration.js
```

## Test Coverage

The tests verify the following key fixes for the 2-second video issue:

1. **Minimum Duration Enforcement**: Even if `fallbackDuration` is short (e.g., 2000ms), the recording will be at least 8000ms + 1200ms = 9200ms (9.2 seconds)

2. **Video Looping**: The video element has `loop = true` to prevent the video from ending and causing early recording termination

3. **No Early Termination**: Removed the `video.addEventListener('ended')` handler that was stopping recording when the source video ended

4. **Proper Initialization**: The compositor signals `COMPOSITOR_READY` correctly and within reasonable time limits

## Architecture Verification

These tests confirm that the TypeScript React migration maintains:

- ✅ All original compositor functionality
- ✅ Proper Three.js scene initialization
- ✅ MediaRecorder API integration
- ✅ Camera choreography and timeline processing
- ✅ Shader loading and development tools
- ✅ Studio server API compatibility

## Debugging

If tests fail, check:

1. Studio server is not already running on port 7788 (tests use 7799)
2. Playwright is installed: `npx playwright install`
3. Build is up to date: `npm run build:client`
4. No TypeScript compilation errors: `npm run typecheck`
