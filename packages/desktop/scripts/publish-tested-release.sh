#!/usr/bin/env bash
# Only invoked by the protected manual workflow, after trusted staging.
set -euo pipefail
export LC_ALL=C
root=${1:?expected staged directory}
repo=BharatCode-ai/bharatcode-desktop
api="repos/$repo"
[[ "$GITHUB_REPOSITORY" == "$repo" && "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ && "$CANDIDATE_SHA256" =~ ^[a-f0-9]{64}$ ]]
[[ "$SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ && "$SOURCE_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
[[ "$MANUAL_ACCEPTANCE" == true && "$APPROVE_UNSIGNED_WINDOWS" == true && -n "${ACCEPTANCE_NOTES//[[:space:]]/}" ]]
stable=${RELEASE_TAG:?}
version=${stable#desktop-}
[[ "$stable" == desktop-"$version" && "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$(printf '%s\n' 1.15.51 "$version" | sort -V | head -1)" == 1.15.51 ]]
(cd "$root/stable" && sha256sum --strict --check SHA256SUMS)
bridge=''
if [[ "$version" == 1.15.51 ]]; then bridge=desktop-beta-1.15.51; fi
jq -e --arg stable "$stable" --arg bridge "$bridge" --arg sha "$SOURCE_SHA" --arg hash "$CANDIDATE_SHA256" \
  --arg run "$SOURCE_RUN_ID" --arg attempt "$SOURCE_RUN_ATTEMPT" --arg repo "$repo" '
  .tag == $stable and (.compatibility // "") == $bridge and .candidateSha256 == $hash and
  ("desktop-" + .identity.version) == $stable and .identity.channel == "prod" and .identity.repository == $repo and .identity.source == $sha and
  .identity.run == $run and .identity.attempt == $attempt and .acceptance == "pending" and
  .publication == "not-authorized"' "$root/stable/release-manifest.json" >/dev/null

die() { echo "Release conflict: $*" >&2; exit 1; }

# Do not adopt an orphan tag, even when its name happens to match. For a
# published release, verify the real tag target as well as target_commitish.
check_ref() {
  local ref object depth annotated
  ref=$(gh api "$api/git/matching-refs/tags/$tag" | jq -ce --arg ref "refs/tags/$tag" '[.[] | select(.ref == $ref)]')
  if [[ "$1" == absent ]]; then
    [[ "$ref" == '[]' ]] || die "pre-existing tag $tag"
    return
  fi
  object=$(jq -ce 'select(length == 1) | .[0].object' <<<"$ref")
  for ((depth=0; depth<8; depth++)); do
    if jq -e --arg sha "$SOURCE_SHA" '.type == "commit" and .sha == $sha' <<<"$object" >/dev/null; then return; fi
    annotated=$(jq -er 'select(.type == "tag") | .sha | select(test("^[a-f0-9]{40}$"))' <<<"$object")
    object=$(gh api "$api/git/tags/$annotated" | jq -ce '.object')
  done
  die "unexpected target of $tag"
}

verify_release() {
  jq -e --argjson id "$id" --arg tag "$tag" --arg sha "$SOURCE_SHA" --arg name "$name" --arg notes "$notes" \
    --argjson pre "$pre" --argjson draft "$1" --argjson expected "$expected" --argjson complete "$2" '
    .id == $id and .tag_name == $tag and .target_commitish == $sha and .name == $name and
    .draft == $draft and .prerelease == $pre and ($draft or .immutable == true) and
    (.body | startswith($notes + "\nApproved by ") and
      (.[($notes|length):] | test("^\nApproved by [a-zA-Z0-9_\\[\\]-]+ at [0-9T:Z-]+$"))) and
    (.assets | type == "array" and (map(.name) | unique | length) == length and
      all(.[]; .state == "uploaded" and $expected[.name] != null and .digest == $expected[.name]) and
      ($complete == false or length == ($expected|length)))' <<<"$release" >/dev/null || die "identity, approval or asset mismatch on $tag"
}

reconcile() {
  local tag=$1 dir=$2 pre=$3 name="BharatCode $1" notes ids id release draft expected file sum actual
  notes=$(printf '%s\n\nSource: %s\nBuild: https://github.com/%s/actions/runs/%s/attempts/%s\nTested cohort manifest SHA-256: %s\nWindows and Linux are unsigned; both macOS architectures are Developer ID signed and notarized.\nPackage-build receipts are not acceptance results. Manual QA and explicitly approved limitations:\n%s' \
    "$4" "$SOURCE_SHA" "$repo" "$SOURCE_RUN_ID" "$SOURCE_RUN_ATTEMPT" "$CANDIDATE_SHA256" "$ACCEPTANCE_NOTES")
  expected=$(cd "$dir" && sha256sum -- * | jq -Rn '[inputs | capture("^(?<digest>[a-f0-9]{64})  (?<key>[a-zA-Z0-9._-]+)$") // error("invalid asset name") | {key, value:("sha256:"+.digest)}] | from_entries')
  local manifest="$root/stable/release-manifest.json"
  if [[ "$pre" == true ]]; then
    jq -e 'keys == ["beta-linux.yml","beta-mac.yml","beta.yml"]' <<<"$expected" >/dev/null
    jq -e --argjson expected "$expected" '
      (.compatibilityFiles | map({key:.name,value:("sha256:"+.sha256)}) | from_entries) == $expected' "$manifest" >/dev/null
  else
    jq -e --argjson expected "$expected" '
      (.files | map({key:.name,value:("sha256:"+.sha256)}) | from_entries) ==
      ($expected | del(.SHA256SUMS, .["release-manifest.json"]))' "$manifest" >/dev/null
  fi
  ids=$(gh api "$api/releases?per_page=100" --paginate --slurp | jq -ce --arg tag "$tag" '[.[][] | select(.tag_name == $tag) | .id]')
  if [[ "$ids" == '[]' ]]; then
    check_ref absent
    release=$(jq -n --arg tag "$tag" --arg name "$name" --arg sha "$SOURCE_SHA" --argjson pre "$pre" \
      --arg body "$notes"$'\n'"Approved by $GITHUB_ACTOR at $(date -u +%FT%TZ)" \
      '{tag_name:$tag,target_commitish:$sha,name:$name,body:$body,draft:true,prerelease:$pre}' |
      gh api "$api/releases" --method POST --input -)
    id=$(jq -er '.id | numbers' <<<"$release")
  else
    id=$(jq -er 'select(length == 1) | .[0] | numbers' <<<"$ids")
    release=$(gh api "$api/releases/$id")
  fi
  draft=$(jq -er '.draft | tostring' <<<"$release")
  if [[ "$draft" == true ]]; then
    check_ref absent
    verify_release true false
    for file in "$dir"/*; do
      if ! jq -e --arg name "${file##*/}" 'any(.assets[]; .name == $name)' <<<"$release" >/dev/null; then
        gh release upload "$tag" "$file" --repo "$repo"
      fi
    done
    release=$(gh api "$api/releases/$id")
    verify_release true true
    check_ref absent
    # Leave the repository-wide "latest" alias to its existing consumers (CLI).
    gh api "$api/releases/$id" --method PATCH -F draft=false -F "prerelease=$pre" -f make_latest=false >/dev/null
  fi
  release=$(gh api "$api/releases/tags/$tag")
  verify_release false true
  check_ref published
  # Verify anonymous client-facing bytes, not just authenticated API responses.
  for file in "$dir"/*; do
    sum=$(jq -er --arg key "${file##*/}" '.[$key] | ltrimstr("sha256:")' <<<"$expected")
    actual=$(curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      "https://github.com/$repo/releases/download/$tag/${file##*/}" | sha256sum)
    [[ "${actual%% *}" == "$sum" ]] || die "public download mismatch for $tag/${file##*/}"
  done
}

reconcile "$stable" "$root/stable" false "BharatCode Desktop stable."
# Never expose a legacy pointer until the canonical release is immutable and
# every public download has passed. A retry revalidates it without mutation.
if [[ -n "$bridge" ]]; then
  reconcile "$bridge" "$root/compatibility" true "One-time Desktop updater compatibility metadata. Installers: https://github.com/$repo/releases/tag/$stable"
fi
