import { Loader2, LockKeyhole, LogIn, Mail } from 'lucide-react';
import { FormEvent, useState } from 'react';

interface LoginViewProps {
  onLogin: (email: string, password: string) => Promise<void>;
}

export function LoginView({ onLogin }: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark">SR</span>
          <div>
            <strong>smartWebRide</strong>
            <small>Center access</small>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div>
            <p className="eyebrow">登录</p>
            <h1 id="login-title">邮件账号</h1>
          </div>

          <label className="login-field">
            <span>邮箱</span>
            <span className="login-input-wrap">
              <Mail size={16} />
              <input
                autoComplete="email"
                inputMode="email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@rbbn.com"
                type="email"
                value={email}
              />
            </span>
          </label>

          <label className="login-field">
            <span>密码</span>
            <span className="login-input-wrap">
              <LockKeyhole size={16} />
              <input
                autoComplete="current-password"
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="输入密码"
                type="password"
                value={password}
              />
            </span>
          </label>

          {error ? <p className="login-error">{error}</p> : null}

          <button className="primary-button login-submit" disabled={!email.trim() || !password || submitting} type="submit">
            {submitting ? <Loader2 className="spin-icon" size={16} /> : <LogIn size={16} />}
            {submitting ? '登录中' : '进入'}
          </button>
        </form>
      </section>
    </main>
  );
}
