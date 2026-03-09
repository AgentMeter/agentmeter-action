import * as core from '@actions/core';
import { run } from './run';

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
