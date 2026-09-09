# BharatCode release review authority

The protected publication stages use distinct named human reviewers. This
assignment does not authorize publication by itself.

- `desktop-beta-release` requires approval from `Pankaj-IIT` after reviewing
  the exact Desktop source SHA, workflow run and attempt, closed cohort,
  artifact digests, signing states, acceptance results, and rollback state.
- The CLI repository's `npm-next` stage separately requires `Pankaj-IIT`.
- The CLI repository's `npm-latest` stage requires an independent approval
  from `satyamlohiya` after the immutable `next` receipt is available.

GitHub environment protection has `prevent_self_review` enabled for all three
stages. An administrator bypass is not accepted as review evidence. The
initiator, source author, and required reviewer must be recorded; the reviewer
must not be the initiator or approve their own deployment. Review approval is
stage-specific and cannot be reused between Desktop, npm `next`, and npm
`latest`.

Retain the GitHub deployment approval record for each stage with the exact
repository, environment, reviewer login, source SHA, workflow path, run ID,
run attempt, deployment ID, approval time, and the applicable cohort, package,
or receipt SHA-256. Missing, bypassed, mismatched, self-approved, or replayed
review evidence keeps publication blocked.

Reviewer assignment alone does not permit workflow dispatch, draft creation,
prerelease finalization, npm publication, dist-tag promotion, website cutover,
or any other release mutation. Those actions still require the remaining
release gates and explicit authorized execution.
