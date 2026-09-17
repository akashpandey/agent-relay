# Sourced after the wrapper creates its log path and cleanup function.
write_done() {
  node "$repo_dir/scripts/write-done.mjs" "$log_file" "$done_provider" "$workspace" "$done_model" "${resume_session:-new}" "$1"
}

finalize_run() {
  final_status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ ! -f "${log_file%.log}.done" ]; then
    write_done "$final_status" || final_status=1
  fi
  stop_subagent
  exit "$final_status"
}
trap finalize_run EXIT
trap 'exit 143' HUP INT TERM
