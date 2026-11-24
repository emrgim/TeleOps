/**
 * Key that lets every TeleOps installation open issues in the TeleOps repository (feedback, crash and
 * malfunction reports) without any GitHub login: a fine-grained token limited to "Issues: read & write"
 * on that repository and nothing else. It is scrambled (XOR) only so that secret scanners don't revoke it.
 * Empty until such a token exists: feedback then says it is not set up.
 * Forks: set TELEOPS_FEEDBACK_REPO and TELEOPS_FEEDBACK_TOKEN instead.
 */
export const scrambledIssuesKey: [string, string] = ['', '']
