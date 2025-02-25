/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

/**
 * @fileoverview
 * This script performs quick checks on the source code
 * prior to running unit and integration tests.
 * This is run during the CI stage = build; job = checks.
 */

const {
  printChangeSummary,
  startTimer,
  stopTimer,
  timedExecOrDie: timedExecOrDieBase,
  verifyBranchCreationPoint,
} = require('./utils');
const {determineBuildTargets} = require('./build-targets');
const {isTravisPullRequestBuild} = require('../travis');
const {reportAllExpectedTests} = require('../tasks/report-test-status');
const {runYarnChecks} = require('./yarn-checks');

const FILENAME = 'checks.js';
const timedExecOrDie = (cmd, unusedFileName) =>
  timedExecOrDieBase(cmd, FILENAME);

function main() {
  const startTime = startTimer(FILENAME, FILENAME);
  if (!runYarnChecks(FILENAME)) {
    stopTimer(FILENAME, FILENAME, startTime);
    process.exitCode = 1;
    return;
  }

  if (!isTravisPullRequestBuild()) {
    timedExecOrDie('gulp update-packages');
    timedExecOrDie('gulp check-exact-versions');
    timedExecOrDie('gulp lint');
    timedExecOrDie('gulp presubmit');
    timedExecOrDie('gulp ava');
    timedExecOrDie('gulp babel-plugin-tests');
    timedExecOrDie('gulp caches-json');
    timedExecOrDie('gulp json-syntax');
    timedExecOrDie('gulp dev-dashboard-tests');
    timedExecOrDie('gulp dep-check');
    timedExecOrDie('gulp check-types');
  } else {
    if (!verifyBranchCreationPoint(FILENAME)) {
      stopTimer(FILENAME, FILENAME, startTime);
      process.exitCode = 1;
      return;
    }
    printChangeSummary(FILENAME);
    const buildTargets = determineBuildTargets(FILENAME);
    reportAllExpectedTests(buildTargets);
    timedExecOrDie('gulp update-packages');

    timedExecOrDie('gulp check-exact-versions');
    timedExecOrDie('gulp lint');
    timedExecOrDie('gulp presubmit');

    if (buildTargets.has('AVA')) {
      timedExecOrDie('gulp ava');
    }

    if (buildTargets.has('BABEL_PLUGIN')) {
      timedExecOrDie('gulp babel-plugin-tests');
    }

    if (buildTargets.has('CACHES_JSON')) {
      timedExecOrDie('gulp caches-json');
      timedExecOrDie('gulp json-syntax');
    }

    // Check document links only for PR builds.
    if (buildTargets.has('DOCS')) {
      timedExecOrDie('gulp check-links');
    }

    if (buildTargets.has('DEV_DASHBOARD')) {
      timedExecOrDie('gulp dev-dashboard-tests');
    }

    if (buildTargets.has('RUNTIME')) {
      timedExecOrDie('gulp dep-check');
      timedExecOrDie('gulp check-types');
    }
  }

  stopTimer(FILENAME, FILENAME, startTime);
}

main();
