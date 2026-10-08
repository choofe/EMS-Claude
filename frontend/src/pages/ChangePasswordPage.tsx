import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ErrorAlert } from "../components/common";

export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const forced = !!user?.must_change_password;
  const mismatch = again !== "" && next !== again;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2, bgcolor: "grey.100" }}>
      <Card sx={{ width: "100%", maxWidth: 420 }}>
        <CardContent>
          <form onSubmit={submit} noValidate>
            <Stack gap={2}>
              <Typography variant="h5" component="h1" textAlign="center">تغییر رمز عبور</Typography>
              {forced && <Alert severity="warning">برای ادامه باید رمز عبور خود را تغییر دهید.</Alert>}
              <TextField label="رمز عبور فعلی" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" slotProps={{ htmlInput: { dir: "ltr" } }} />
              <TextField label="رمز عبور جدید" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" slotProps={{ htmlInput: { dir: "ltr" } }} />
              <TextField label="تکرار رمز عبور جدید" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password"
                error={mismatch} helperText={mismatch ? "تکرار رمز با رمز جدید یکسان نیست." : undefined} slotProps={{ htmlInput: { dir: "ltr" } }} />
              <ErrorAlert error={error} />
              <Button type="submit" variant="contained" size="large" disabled={busy || !current || !next || next !== again}>ذخیره رمز جدید</Button>
              {forced ? (
                <Button onClick={async () => { await logout(); navigate("/login"); }}>خروج</Button>
              ) : (
                <Button onClick={() => navigate(-1)}>بازگشت</Button>
              )}
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
