export const metadata = {
  title: "Login — Verification Tool",
};

export default function LoginPage() {
  return (
    <main style={{ padding: "3rem", maxWidth: "32rem", margin: "0 auto" }}>
      <h1>Login</h1>
      <p>Login will be implemented later.</p>
      <p>
        Real authentication (Microsoft OAuth) lands in a later sprint. Until then,
        admin access requires the dev-only <code>AUTH_DEV_DEMO_USER</code> flag.
      </p>
    </main>
  );
}
