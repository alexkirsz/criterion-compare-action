const { inspect } = require("util");
const { basename, join } = require("path");
const { mkdtemp, copyFile } = require("fs/promises");
const exec = require("@actions/exec");
const core = require("@actions/core");
const github = require("@actions/github");

const context = github.context;

async function main() {
  const inputs = {
    token: core.getInput("token", { required: true }),
    branchName: core.getInput("branchName", { required: true }),
    cwd: core.getInput("cwd"),
    benchName: core.getInput("benchName"),
    features: core.getInput("features"),
    defaultFeatures: core.getInput("defaultFeatures"),
  };
  core.debug(`Inputs: ${inspect(inputs)}`);

  const options = {};
  let myOutput = "";
  let myError = "";
  if (inputs.cwd) {
    options.cwd = inputs.cwd;
  }

  let benchCmd = ["bench"];
  if (inputs.benchName) {
    benchCmd = benchCmd.concat(["--bench", inputs.benchName]);
  }

  if (!inputs.defaultFeatures) {
    benchCmd = benchCmd.concat(["--no-default-features"]);
  }

  if (inputs.features) {
    benchCmd = benchCmd.concat(["--features", inputs.features]);
  }

  core.debug("### Install Critcmp ###");
  await exec.exec("cargo", ["install", "critcmp"]);

  core.debug("### Compiling ###");
  async function getExecutables() {
    let output = "";
    await exec.exec("cargo", benchCmd.concat(["--no-run"]), {
      listeners: {
        stderr: (data) => {
          output += data.toString();
        },
      },
    });
    let executables = new Set();
    for (const line of output.split("\n")) {
      const match = /Executable.+(target[\\\/]release[\\\/][^)]+)/.exec(line);
      if (match) {
        executables.add(match[1]);
      }
    }
    return executables;
  }
  async function listCases(executable) {
    let output = "";
    await exec.exec(executable, ["--bench", "--list"], {
      listeners: {
        stdout: (data) => {
          output += data.toString();
        },
      },
    });
    let cases = new Set();
    for (const line of output.split("\n")) {
      const match = /^(.+): bench$/.exec(line);
      if (match) {
        cases.add(match[1]);
      }
    }
    return cases;
  }
  async function listAllCases(executables) {
    let object = {};
    for (const executable of executables) {
      let cases = await listCases(executable);
      for (const testCase of cases) {
        object[testCase] = executable;
      }
    }
    return object;
  }
  async function moveExecutables(executables) {
    const newExecutables = new Set();
    const dir = await mkdtemp("criterion-compare");
    for (const executable of executables) {
      const name = basename(executable);
      const path = join(dir, name);
      await copyFile(executable, path);
      newExecutables.add(path);
    }
    return newExecutables;
  }
  await exec.exec("cargo", benchCmd.concat(["--no-run"]), options);
  core.debug("Changes compiled");

  const changesExecutables = await getExecutables();
  const movedChangesExecutables = await moveExecutables(changesExecutables);
  const changesTestCases = await listAllCases(movedChangesExecutables);
  core.debug("Changes listed");

  await exec.exec("git", [
    "checkout",
    core.getInput("branchName") || github.base_ref,
  ]);
  core.debug("Checked out to base branch");

  await exec.exec("cargo", benchCmd.concat(["--no-run"]), options);
  core.debug("Base compiled");

  const baseExecutables = await getExecutables();
  const movedBaseExecutables = await moveExecutables(baseExecutables);
  const baseTestCases = await listAllCases(movedBaseExecutables);
  core.debug("Base listed");

  await exec.exec("git", ["checkout", "-"]);
  core.debug("Checked out to changes branch");

  core.debug("### Benchmark starting ###");
  let onBaseBranch = false;
  for (const testCase of new Set([
    ...Object.keys(changesTestCases),
    ...Object.keys(baseTestCases),
  ])) {
    const changesExecutable = changesTestCases[testCase];
    const baseExecutable = baseTestCases[testCase];

    if (changesExecutable) {
      if (onBaseBranch) {
        await exec.exec("git", ["checkout", "-"]);
        core.debug(`${testCase}: Checked out to changes branch`);
        onBaseBranch = false;
      }

      await exec.exec(
        changesExecutable,
        ["--bench", testCase, "--save-baseline", "changes"],
        options
      );
      core.debug(`${testCase}: Changes benchmarked`);
    }

    if (baseExecutable) {
      if (!onBaseBranch) {
        await exec.exec("git", [
          "checkout",
          core.getInput("branchName") || github.base_ref,
        ]);
        core.debug(`${testCase}: Checked out to base branch`);
        onBaseBranch = true;
      }

      await exec.exec(
        baseExecutable,
        ["--bench", testCase, "--save-baseline", "base"],
        options
      );
      core.debug(`${testCase}: Base benchmarked`);
    }
  }

  if (onBaseBranch) {
    await exec.exec("git", ["checkout", "-"]);
    core.debug(`${testCase}: Checked out to changes branch`);
    onBaseBranch = false;
  }

  options.listeners = {
    stdout: (data) => {
      myOutput += data.toString();
    },
    stderr: (data) => {
      myError += data.toString();
    },
  };

  await exec.exec("critcmp", ["base", "changes"], options);

  core.setOutput("stdout", myOutput);
  core.setOutput("stderr", myError);

  const resultsAsMarkdown = convertToMarkdown(myOutput);

  // An authenticated instance of `@octokit/rest`
  const octokit = github.getOctokit(inputs.token);

  const contextObj = { ...context.issue };

  try {
    const { data: comment } = await octokit.rest.issues.createComment({
      owner: contextObj.owner,
      repo: contextObj.repo,
      issue_number: contextObj.number,
      body: resultsAsMarkdown,
    });
    core.info(
      `Created comment id '${comment.id}' on issue '${contextObj.number}' in '${contextObj.repo}'.`
    );
    core.setOutput("comment-id", comment.id);
  } catch (err) {
    core.warning(`Failed to comment: ${err}`);
    core.info("Commenting is not possible from forks.");

    // If we can't post to the comment, display results here.
    // forkedRepos only have READ ONLY access on GITHUB_TOKEN
    // https://github.community/t5/GitHub-Actions/quot-Resource-not-accessible-by-integration-quot-for-adding-a/td-p/33925
    const resultsAsObject = convertToTableObject(myOutput);
    console.table(resultsAsObject);
  }

  core.debug("Succesfully run!");
}

function convertDurToSeconds(dur, units) {
  let seconds;
  switch (units) {
    case "s":
      seconds = dur;
      break;
    case "ms":
      seconds = dur / 1000;
      break;
    case "µs":
      seconds = dur / 1000000;
      break;
    case "ns":
      seconds = dur / 1000000000;
      break;
    default:
      seconds = dur;
      break;
  }

  return seconds;
}

const SIGNIFICANT_FACTOR = 2;

function isSignificant(changesDur, changesErr, baseDur, baseErr) {
  if (changesDur < baseDur) {
    return (
      changesDur + SIGNIFICANT_FACTOR * changesErr <
      baseDur - SIGNIFICANT_FACTOR * baseErr
    );
  } else {
    return (
      changesDur - SIGNIFICANT_FACTOR * changesErr >
      baseDur + SIGNIFICANT_FACTOR * baseErr
    );
  }
}

function diffPercentage(changes, base) {
  return -(1 - changes / base) * 100;
}

function significantDiffPercentage(changesDur, changesErr, baseDur, baseErr) {
  if (changesDur < baseDur) {
    return Math.min(
      0,
      diffPercentage(
        changesDur + SIGNIFICANT_FACTOR * changesErr,
        baseDur - SIGNIFICANT_FACTOR * baseErr
      )
    );
  } else {
    return Math.max(
      0,
      diffPercentage(
        changesDur - SIGNIFICANT_FACTOR * changesErr,
        baseDur + SIGNIFICANT_FACTOR * baseErr
      )
    );
  }
}

function formatPercentage(value) {
  if (value == 0) return "";
  return (value <= 0 ? "" : "+") + value.toFixed(2) + "%";
}

function convertToMarkdown(results) {
  /* Example results:
    group                            base                                   changes
    -----                            ----                                   -------
    character module                 1.03     22.2±0.41ms        ? B/sec    1.00     21.6±0.53ms        ? B/sec
    directory module – home dir      1.02     21.7±0.69ms        ? B/sec    1.00     21.4±0.44ms        ? B/sec
    full prompt                      1.08     46.0±0.90ms        ? B/sec    1.00     42.7±0.79ms        ? B/sec
  */

  let resultLines = results.trimRight().split("\n");
  let benchResults = resultLines
    .slice(2) // skip headers
    .map((row) => row.split(/\s{2,}/)) // split if 2+ spaces together
    .map(
      ([
        name,
        baseFactor,
        baseDuration,
        _baseBandwidth,
        changesFactor,
        changesDuration,
        _changesBandwidth,
      ]) => {
        let baseUndefined = typeof baseDuration === "undefined";
        let changesUndefined = typeof changesDuration === "undefined";

        if (!name || (baseUndefined && changesUndefined)) {
          return "";
        }

        let difference = "N/A";
        let significantDifference = "N/A";
        if (!baseUndefined && !changesUndefined) {
          changesFactor = Number(changesFactor);
          baseFactor = Number(baseFactor);

          let changesDurSplit = changesDuration.split("±");
          let changesUnits = changesDurSplit[1].slice(-2);
          let changesDurSecs = convertDurToSeconds(
            changesDurSplit[0],
            changesUnits
          );
          let changesErrorSecs = convertDurToSeconds(
            changesDurSplit[1].slice(0, -2),
            changesUnits
          );

          let baseDurSplit = baseDuration.split("±");
          let baseUnits = baseDurSplit[1].slice(-2);
          let baseDurSecs = convertDurToSeconds(baseDurSplit[0], baseUnits);
          let baseErrorSecs = convertDurToSeconds(
            baseDurSplit[1].slice(0, -2),
            baseUnits
          );

          difference = diffPercentage(changesDurSecs, baseDurSecs);
          significantDifference = significantDiffPercentage(
            changesDurSecs,
            changesErrorSecs,
            baseDurSecs,
            baseErrorSecs
          );
          difference = formatPercentage(difference);
          significantDifference = formatPercentage(significantDifference);
          if (
            isSignificant(
              changesDurSecs,
              changesErrorSecs,
              baseDurSecs,
              baseErrorSecs
            )
          ) {
            if (changesDurSecs < baseDurSecs) {
              changesDuration = `**${changesDuration}**`;
            } else if (changesDurSecs > baseDurSecs) {
              baseDuration = `**${baseDuration}**`;
            }
          }
        }

        if (baseUndefined) {
          baseDuration = "N/A";
        }

        if (changesUndefined) {
          changesDuration = "N/A";
        }

        name = name.replace(/\|/g, "\\|");

        return `| ${name} | ${baseDuration} | ${changesDuration} | ${difference} | ${significantDifference} |`;
      }
    )
    .join("\n");

  let shortSha = context.sha.slice(0, 7);
  return `## Benchmark for ${shortSha}
  <details>
    <summary>Click to view benchmark</summary>

| Test | Base         | PR               | % | sigificant % |
|------|--------------|------------------|---|--------------|
${benchResults}

  </details>
  `;
}

function convertToTableObject(results) {
  /* Example results:
    group                            base                                   changes
    -----                            ----                                   -------
    character module                 1.03     22.2±0.41ms        ? B/sec    1.00     21.6±0.53ms        ? B/sec
    directory module – home dir      1.02     21.7±0.69ms        ? B/sec    1.00     21.4±0.44ms        ? B/sec
    full prompt                      1.08     46.0±0.90ms        ? B/sec    1.00     42.7±0.79ms        ? B/sec
  */

  let resultLines = results.split("\n");
  let benchResults = resultLines
    .slice(2) // skip headers
    .map((row) => row.split(/\s{2,}/)) // split if 2+ spaces together
    .map(
      ([
        name,
        baseFactor,
        baseDuration,
        _baseBandwidth,
        changesFactor,
        changesDuration,
        _changesBandwidth,
      ]) => {
        changesFactor = Number(changesFactor);
        baseFactor = Number(baseFactor);

        let difference = -(1 - changesFactor / baseFactor) * 100;
        difference =
          (changesFactor <= baseFactor ? "" : "+") + difference.toPrecision(2);
        if (changesFactor < baseFactor) {
          changesDuration = `**${changesDuration}**`;
        } else if (changesFactor > baseFactor) {
          baseDuration = `**${baseDuration}**`;
        }

        return {
          name,
          baseDuration,
          changesDuration,
          difference,
        };
      }
    );

  return benchResults;
}

// IIFE to be able to use async/await
(async () => {
  try {
    await main();
  } catch (e) {
    console.log(e.stack);
    core.setFailed(`Unhanded error:\n${e}`);
  }
})();
