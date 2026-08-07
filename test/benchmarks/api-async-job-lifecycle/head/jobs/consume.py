def consume_result(result):
    job = find_job(result.job_id)
    if result.version < job.version:
        return
    job.status = "succeeded" if result.ok else "failed"
    acknowledge(result.message_id)
