import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from "@mui/material";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ErrorAlert } from "../components/common";

export function LoginPage() {
  const { login, user, notice } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={user.must_change_password ? "/change-password" : from} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2, bgcolor: "grey.100" }}>
      <Card sx={{ width: "100%", maxWidth: 400 }}>
        <CardContent>
          <form onSubmit={submit} noValidate>
            <Stack gap={2}>
              <Typography variant="h5" component="h1" textAlign="center">ورود به سامانه</Typography>
              {notice && <Alert severity="info">{notice}</Alert>}
              <TextField label="نام کاربری" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username"
                slotProps={{ htmlInput: { dir: "ltr", autoCapitalize: "none", spellCheck: false } }} />
              <TextField label="رمز عبور" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
                slotProps={{ htmlInput: { dir: "ltr" } }} />
              <ErrorAlert error={error} />
              <Button type="submit" variant="contained" size="large" disabled={busy || !username || !password}>ورود</Button>
              <Typography variant="body2" color="text.secondary" textAlign="center">
                رمز عبور را فراموش کرده‌اید؟ با مدیر سیستم تماس بگیرید.
              </Typography>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
