"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { releaseOptions } = require("../scripts/github-publish.cjs");

test("release tags map to the matching npm channel", () => {
  for (const [version, tag] of [["1.2.3", "latest"], ["1.2.3-alpha.1", "alpha"], ["1.2.3-beta.2", "beta"], ["1.2.3-rc.1", "rc"]]) {
    const actual = releaseOptions({ GITHUB_REF: "refs/tags/agent_" + version });
    assert.equal(actual.version, version);
    assert.equal(actual.tag, tag);
  }
});

test("branches, malformed versions and stable pipeline-only releases are rejected", () => {
  for (const ref of ["refs/heads/main", "refs/tags/1.2.3", "refs/tags/agent_01.2.3", "refs/tags/agent_1.2.3-alpha.01", "refs/tags/agent_1.2.3;echo bad"]) {
    assert.throws(() => releaseOptions({ GITHUB_REF: ref }));
  }
  for (const version of ["1.2.3", "1.2.3-beta.1", "1.2.3-rc.1"]) {
    assert.throws(() => releaseOptions({ GITHUB_REF: "refs/tags/agent_" + version, ELECTRON_PIPELINE_ONLY: "true" }));
  }
  assert.throws(() => releaseOptions({ GITHUB_REF: "refs/tags/agent_1.2.3-alpha.1", ELECTRON_PIPELINE_ONLY: "yes" }));
  assert.equal(releaseOptions({ GITHUB_REF: "refs/tags/agent_1.2.3-alpha.1", ELECTRON_PIPELINE_ONLY: "true" }).pipelineOnly, true);
});
