package core

import "testing"

/*
"Not installed" and "ran and failed" are different answers, and the CLI has more than one way
of saying the first.

Seven call sites each carried their own copy of the same two-string test, and every one of them
shared the same blind spot: on a machine with no Scout plugin the Docker CLI answers a
`docker scout cves --format sarif …` invocation by complaining about the flag and printing its
own top-level usage, saying nothing about `scout` at all. All seven called that a broken plugin.

Found by running the acceptance suite on a CI runner rather than by reading, which is why the
stderr below is reproduced verbatim from that run instead of paraphrased.
*/
func TestDockerPluginMissingRecognisesEveryRefusalTheCLIUses(t *testing.T) {
	missing := map[string]string{
		"the familiar phrasing": "docker: 'model' is not a docker command.\nSee 'docker --help'",
		"the terser variant":    "unknown command \"scout\" for \"docker\"",
		// Verbatim from ubuntu-24.04 with no Scout plugin, exit code 125.
		"top-level usage, no plugin named at all": "unknown flag: --format\n\n" +
			"Usage:  docker [OPTIONS] COMMAND [ARG...]\n\n" +
			"Run 'docker --help' for more information",
	}
	for label, stderr := range missing {
		if !dockerPluginMissing(stderr) {
			t.Errorf("%s should read as an absent plugin, got present: %q", label, stderr)
		}
	}

	/*
	 * The other half of the distinction, and the reason `unknown flag` alone is not the test.
	 * A plugin that ran and rejected something prints its own usage; treating that as "not
	 * installed" would turn a real failure into a silent skip, which is exactly what
	 * recordSkipped in the acceptance suite exists to avoid being abused for.
	 */
	present := map[string]string{
		"a plugin rejecting its own flag": "unknown flag: --nope\n\n" +
			"Usage:  docker scout cves [IMAGE|DIRECTORY|ARCHIVE] [flags]\n\n" +
			"Run 'docker scout cves --help' for more information",
		"a plugin failing on the work itself": "ERROR failed to analyze image: " +
			"authentication required",
		"an engine error": "Error response from daemon: no such image",
	}
	for label, stderr := range present {
		if dockerPluginMissing(stderr) {
			t.Errorf("%s is a failure, not an absent plugin: %q", label, stderr)
		}
	}
}
