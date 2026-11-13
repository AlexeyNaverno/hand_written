/**
 * Test-only loader for OpenCV.js. The package exports a "thenable" object; a dynamic import of it (which the test
 * runner uses) would wait forever, so in tests it is loaded with require and re-exported as a plain default export.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cv = require('@techstark/opencv-js');
export default cv;
