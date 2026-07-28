import React, { useState } from "react";
import { useForm } from "react-hook-form";

interface FeedbackForm {
  email: string;
}

export function FeedbackPage() {
  const [submitted, setSubmitted] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FeedbackForm>({ mode: "onChange" });

  return (
    <main>
      <h1>Share feedback</h1>
      <form noValidate onSubmit={handleSubmit(() => setSubmitted(true))}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          data-testid="email-input"
          {...register("email", {
            required: "Email is required",
            pattern: { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: "Invalid email" },
          })}
        />
        {errors.email ? <p data-testid="email-error">{errors.email.message}</p> : null}
        <button type="submit" data-testid="feedback-submit">
          Send feedback
        </button>
        {submitted ? <p data-testid="feedback-sent">Feedback sent</p> : null}
      </form>
    </main>
  );
}
