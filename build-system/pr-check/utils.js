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

const colors = require('ansi-colors');
const requestPromise = require('request-promise');
const {
  gitBranchCreationPoint,
  gitBranchName,
  gitCommitHash,
  gitDiffCommitLog,
  gitDiffStatMaster,
  gitTravisMasterBaseline,
  shortSha,
} = require('../git');
const {
  isTravisBuild,
  travisBuildNumber,
  travisPullRequestSha,
} = require('../travis');
const {
  replaceUrls,
  signalDistUploadComplete,
} = require('../tasks/pr-deploy-bot-utils');
const {execOrDie, exec} = require('../exec');

const BUILD_OUTPUT_FILE = isTravisBuild()
  ? `amp_build_${travisBuildNumber()}.zip`
  : '';
const DIST_OUTPUT_FILE = isTravisBuild()
  ? `amp_dist_${travisBuildNumber()}.zip`
  : '';

const BUILD_OUTPUT_DIRS = 'build/ dist/ dist.3p/ EXTENSIONS_CSS_MAP';
const DIST_OUTPUT_DIRS =
  'build/ dist/ dist.3p/ dist.tools/ EXTENSIONS_CSS_MAP examples/ test/manual/';

const OUTPUT_STORAGE_LOCATION = 'gs://amp-travis-builds';
const OUTPUT_STORAGE_KEY_FILE = 'sa-travis-key.json';
const OUTPUT_STORAGE_PROJECT_ID = 'amp-travis-build-storage';
const OUTPUT_STORAGE_SERVICE_ACCOUNT =
  'sa-travis@amp-travis-build-storage.iam.gserviceaccount.com';

const GIT_BRANCH_URL =
  'https://github.com/ampproject/amphtml/blob/master/contributing/getting-started-e2e.md#create-a-git-branch';

/**
 * Checks if the PR branch was forked from `master`
 * @param {string} fileName
 * @return {boolean}
 */
function verifyBranchCreationPoint(fileName) {
  const fileLogPrefix = colors.bold(colors.yellow(`${fileName}:`));
  const branchCreationPoint = gitBranchCreationPoint();
  if (!branchCreationPoint) {
    console.error(
      fileLogPrefix,
      colors.red('ERROR:'),
      'Could not find a common ancestor for',
      colors.cyan(gitBranchName()),
      'and',
      colors.cyan('master') + '. Was this PR branch properly forked?'
    );
    console.error(
      fileLogPrefix,
      colors.yellow('NOTE:'),
      'To fix this, rebase your branch on',
      colors.cyan('master') +
        ', or recreate it by following the instructions at',
      colors.cyan(GIT_BRANCH_URL) + '.'
    );

    return false;
  }
  return true;
}

/**
 * Prints a summary of files changed by, and commits included in the PR.
 * @param {string} fileName
 */
function printChangeSummary(fileName) {
  const fileLogPrefix = colors.bold(colors.yellow(`${fileName}:`));
  let commitSha;

  if (isTravisBuild()) {
    console.log(
      `${fileLogPrefix} ${colors.cyan('origin/master')} is currently at ` +
        `commit ${colors.cyan(shortSha(gitTravisMasterBaseline()))}`
    );
    commitSha = travisPullRequestSha();
  } else {
    commitSha = gitCommitHash();
  }
  console.log(
    `${fileLogPrefix} Testing the following changes at commit ` +
      `${colors.cyan(shortSha(commitSha))}`
  );

  const filesChanged = gitDiffStatMaster();
  console.log(filesChanged);

  const branchCreationPoint = gitBranchCreationPoint();
  console.log(
    `${fileLogPrefix} Commit log since branch`,
    `${colors.cyan(gitBranchName())} was forked from`,
    `${colors.cyan('master')} at`,
    `${colors.cyan(shortSha(branchCreationPoint))}:`
  );
  console.log(gitDiffCommitLog() + '\n');
}

/**
 * Starts connection to Sauce Labs after getting account credentials
 * @param {string} functionName
 */
async function startSauceConnect(functionName) {
  process.env['SAUCE_USERNAME'] = 'amphtml';
  const response = await requestPromise(
    'https://amphtml-sauce-token-dealer.appspot.com/getJwtToken'
  );
  process.env['SAUCE_ACCESS_KEY'] = response.trim();
  const startScCmd = 'build-system/sauce_connect/start_sauce_connect.sh';
  const fileLogPrefix = colors.bold(colors.yellow(`${functionName}:`));
  console.log(
    '\n' + fileLogPrefix,
    'Starting Sauce Connect Proxy:',
    colors.cyan(startScCmd)
  );
  execOrDie(startScCmd);
}

/**
 * Stops connection to Sauce Labs
 * @param {string} functionName
 */
function stopSauceConnect(functionName) {
  const stopScCmd = 'build-system/sauce_connect/stop_sauce_connect.sh';
  const fileLogPrefix = colors.bold(colors.yellow(`${functionName}:`));
  console.log(
    '\n' + fileLogPrefix,
    'Stopping Sauce Connect Proxy:',
    colors.cyan(stopScCmd)
  );
  execOrDie(stopScCmd);
}

/**
 * Starts a timer to measure the execution time of the given function.
 * @param {string} functionName
 * @param {string} fileName
 * @return {DOMHighResTimeStamp}
 */
function startTimer(functionName, fileName) {
  const startTime = Date.now();
  const fileLogPrefix = colors.bold(colors.yellow(`${fileName}:`));
  console.log(
    '\n' + fileLogPrefix,
    'Running',
    colors.cyan(functionName) + '...'
  );
  return startTime;
}

/**
 * Stops the timer for the given function and prints the execution time.
 * @param {string} functionName
 * @param {string} fileName
 * @param {DOMHighResTimeStamp} startTime
 * @return {number}
 */
function stopTimer(functionName, fileName, startTime) {
  const endTime = Date.now();
  const executionTime = endTime - startTime;
  const mins = Math.floor(executionTime / 60000);
  const secs = Math.floor((executionTime % 60000) / 1000);
  const fileLogPrefix = colors.bold(colors.yellow(`${fileName}:`));
  console.log(
    fileLogPrefix,
    'Done running',
    colors.cyan(functionName),
    'Total time:',
    colors.green(mins + 'm ' + secs + 's')
  );
}

/**
 * Executes the provided command and times it. Errors, if any, are printed.
 * @param {string} cmd
 * @param {string} fileName
 * @return {<Object>} Process info.
 */
function timedExec(cmd, fileName = 'utils.js') {
  const startTime = startTimer(cmd, fileName);
  const p = exec(cmd);
  stopTimer(cmd, fileName, startTime);
  return p;
}

/**
 * Executes the provided command and times it. The program terminates in case of
 * failure.
 * @param {string} cmd
 * @param {string} fileName
 */
function timedExecOrDie(cmd, fileName = 'utils.js') {
  const startTime = startTimer(cmd, fileName);
  execOrDie(cmd);
  stopTimer(cmd, fileName, startTime);
}

/**
 * Download output helper
 * @param {string} functionName
 * @param {string} outputFileName
 * @param {string} outputDirs
 * @private
 */
function downloadOutput_(functionName, outputFileName, outputDirs) {
  const fileLogPrefix = colors.bold(colors.yellow(`${functionName}:`));
  const buildOutputDownloadUrl = `${OUTPUT_STORAGE_LOCATION}/${outputFileName}`;

  console.log(
    `${fileLogPrefix} Downloading build output from ` +
      colors.cyan(buildOutputDownloadUrl) +
      '...'
  );
  exec('echo travis_fold:start:download_results && echo');
  authenticateWithStorageLocation_();
  execOrDie(`gsutil cp ${buildOutputDownloadUrl} ${outputFileName}`);
  exec('echo travis_fold:end:download_results');

  console.log(
    `${fileLogPrefix} Extracting ` + colors.cyan(outputFileName) + '...'
  );
  exec('echo travis_fold:start:unzip_results && echo');
  execOrDie(`unzip -o ${outputFileName}`);
  exec('echo travis_fold:end:unzip_results');

  console.log(fileLogPrefix, 'Verifying extracted files...');
  exec('echo travis_fold:start:verify_unzip_results && echo');
  execOrDie(`ls -laR ${outputDirs}`);
  exec('echo travis_fold:end:verify_unzip_results');
}

/**
 * Upload output helper
 * @param {string} functionName
 * @param {string} outputFileName
 * @param {string} outputDirs
 * @private
 */
function uploadOutput_(functionName, outputFileName, outputDirs) {
  const fileLogPrefix = colors.bold(colors.yellow(`${functionName}:`));

  console.log(
    `\n${fileLogPrefix} Compressing ` +
      colors.cyan(outputDirs.split(' ').join(', ')) +
      ' into ' +
      colors.cyan(outputFileName) +
      '...'
  );
  exec('echo travis_fold:start:zip_results && echo');
  execOrDie(`zip -r ${outputFileName} ${outputDirs}`);
  exec('echo travis_fold:end:zip_results');

  console.log(
    `${fileLogPrefix} Uploading ` +
      colors.cyan(outputFileName) +
      ' to ' +
      colors.cyan(OUTPUT_STORAGE_LOCATION) +
      '...'
  );
  exec('echo travis_fold:start:upload_results && echo');
  authenticateWithStorageLocation_();
  execOrDie(`gsutil -m cp -r ${outputFileName} ${OUTPUT_STORAGE_LOCATION}`);
  exec('echo travis_fold:end:upload_results');
}

function authenticateWithStorageLocation_() {
  decryptTravisKey_();
  execOrDie(
    'gcloud auth activate-service-account ' +
      `--key-file ${OUTPUT_STORAGE_KEY_FILE}`
  );
  execOrDie(`gcloud config set account ${OUTPUT_STORAGE_SERVICE_ACCOUNT}`);
  execOrDie('gcloud config set pass_credentials_to_gsutil true');
  execOrDie(`gcloud config set project ${OUTPUT_STORAGE_PROJECT_ID}`);
  execOrDie('gcloud config list');
}

/**
 * Downloads and unzips build output from storage
 * @param {string} functionName
 */
function downloadBuildOutput(functionName) {
  downloadOutput_(functionName, BUILD_OUTPUT_FILE, BUILD_OUTPUT_DIRS);
}

/**
 * Downloads and unzips dist output from storage
 * @param {string} functionName
 */
function downloadDistOutput(functionName) {
  downloadOutput_(functionName, DIST_OUTPUT_FILE, DIST_OUTPUT_DIRS);
}

/**
 * Zips and uploads the build output to a remote storage location
 * @param {string} functionName
 */
function uploadBuildOutput(functionName) {
  uploadOutput_(functionName, BUILD_OUTPUT_FILE, BUILD_OUTPUT_DIRS);
}

/**
 * Zips and uploads the dist output to a remote storage location
 * @param {string} functionName
 */
function uploadDistOutput(functionName) {
  uploadOutput_(functionName, DIST_OUTPUT_FILE, DIST_OUTPUT_DIRS);
}

/**
 * Replaces URLS in HTML files, zips and uploads dist output,
 * and signals to the AMP PR Deploy bot that the upload is complete.
 * @param {string} functionName
 */
async function processAndUploadDistOutput(functionName) {
  await replaceUrls('test/manual');
  await replaceUrls('examples');
  uploadDistOutput(functionName);
  await signalDistUploadComplete();
}

/**
 * Decrypts key used by storage service account
 */
function decryptTravisKey_() {
  // -md sha256 is required due to encryption differences between
  // openssl 1.1.1a, which was used to encrypt the key, and
  // openssl 1.0.2g, which is used by Travis to decrypt.
  execOrDie(
    `openssl aes-256-cbc -md sha256 -k ${process.env.GCP_TOKEN} -in ` +
      `build-system/sa-travis-key.json.enc -out ${OUTPUT_STORAGE_KEY_FILE} -d`
  );
}

module.exports = {
  downloadBuildOutput,
  downloadDistOutput,
  printChangeSummary,
  processAndUploadDistOutput,
  startTimer,
  stopTimer,
  startSauceConnect,
  stopSauceConnect,
  timedExec,
  timedExecOrDie,
  uploadBuildOutput,
  uploadDistOutput,
  verifyBranchCreationPoint,
};
