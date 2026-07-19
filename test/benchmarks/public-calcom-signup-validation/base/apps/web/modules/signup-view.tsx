import { useForm } from "react-hook-form";

type FormValues = {
  email: string;
  password: string;
};

export default function SignupView() {
  const formMethods = useForm<FormValues>({
    defaultValues: {
      email: "",
      password: "",
    },
    mode: "onChange",
  });
  const {
    register,
    formState: { errors },
  } = formMethods;

  return (
    <form aria-label="Create account">
      <label htmlFor="email">Email</label>
      <input id="email" type="email" data-testid="email-input" {...register("email")} />
      {errors.email && <span data-testid="email-error">Invalid email</span>}

      <label htmlFor="password">Password</label>
      <input id="password" type="password" data-testid="password-input" {...register("password")} />
      <button type="submit">Create account</button>
    </form>
  );
}
