def submit_job(payload):
    job = enqueue_job("render", payload)
    job.status = "pending"
    job.save()
    return job
