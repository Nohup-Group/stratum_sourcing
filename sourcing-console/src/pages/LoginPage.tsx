import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { setKey } from "../api";

export default function LoginPage() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/console/auth/check", {
      headers: { "X-Console-Key": value },
    });
    setBusy(false);
    if (response.ok) {
      setKey(value);
      navigate("/");
    } else {
      setError("That key didn't work. Check with the Nohup team.");
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>
          Stratum<sup style={{ color: "var(--accent)" }}>3</sup> Sourcing Console
        </h1>
        <p>Enter the access key to open the sourcing intelligence console.</p>
        <input
          className="input"
          type="password"
          placeholder="Access key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error ? <div className="error-text">{error}</div> : null}
        <button className="btn primary" type="submit" disabled={busy || !value}>
          {busy ? "Checking…" : "Open console"}
        </button>
      </form>
    </div>
  );
}
