# Sourced after the wrapper creates its log path and cleanup function.
done_unit=""
if [ "$use_systemd" -eq 1 ]; then done_unit="$unit"; fi
write_done() {
  sess_id="$(node "$repo_dir/scripts/write-done.mjs" "$log_file" "$done_provider" "$workspace" "$done_model" "${resume_session:-new}" "$1" "${done_log_offset:-}")" || return 1
  conv_id="$sess_id"
}

mark_output_start() {
  printf 'agent-output-start: %s\n' "$$" >> "$log_file"
  done_log_offset="$(wc -c < "$log_file" | tr -d ' ')"
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
