import { useEffect, useRef, useState } from "react";
import { Alert, Button, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, Switch, TextField, Typography } from "@mui/material";
import { derivedPassword, generateRandomPassword, mobilePassword, type PasswordMethod } from "../lib/passwordMethods";
import { HelpHint } from "./HelpHint";

interface Props {
  /** the person's mobile and personnel code, as typed or stored: they feed the «mobile» and «derived» methods */
  mobile: string | null | undefined;
  personnelCode: string | number | null | undefined;
  /** the account is MANAGEMENT or AUDITOR: a guessable password then forces the change at the first sign-in */
  privileged: boolean;
  mustChange: boolean;
  onMustChange: (v: boolean) => void;
  /** the password for the form; an empty string means «no method chosen yet» (the caller keeps its save button disabled) */
  onPassword: (password: string) => void;
}

const HELP = (
  <>
    <p style={{ marginTop: 0 }}>«تصادفی»: رمزی ۸ تا ۱۰ نویسه‌ای از حروف کوچک و عدد، بدون نویسه‌های شبیه هم؛ قبل از ثبت آن را کپی کنید، پس از بستن پنجره دیگر نمایش داده نمی‌شود.</p>
    <p>«شمارهٔ موبایل»: خود شماره به‌عنوان رمز؛ «مشتق از موبایل و کد»: شماره‌ای که چهار رقم آخرش با کد پرسنلی (چهار رقمی) عوض شده است.</p>
    <p style={{ marginBottom: 0 }}>روش انتخاب‌شده ثبت یا بایگانی نمی‌شود؛ فقط خود رمز در سرور نگه داشته می‌شود (به‌صورت درهم‌شده).</p>
  </>
);

/**
 * One chooser for every place a manager sets a temporary password (new person with an account, account for an existing
 * person, password reset). NO method is preselected; until one is chosen the password stays empty.
 */
export function PasswordChooser({ mobile, personnelCode, privileged, mustChange, onMustChange, onPassword }: Props) {
  const [method, setMethod] = useState<PasswordMethod>("none");
  const [random, setRandom] = useState("");
  const [manual, setManual] = useState("");
  const [copied, setCopied] = useState(false);
  const emit = useRef(onPassword);
  emit.current = onPassword;

  const mobileValue = mobilePassword(mobile);
  const derivedValue = derivedPassword(mobile, personnelCode);
  const password = method === "random" ? random : method === "mobile" ? mobileValue ?? "" : method === "derived" ? derivedValue ?? "" : method === "manual" ? manual : "";
  const guessable = method === "mobile" || method === "derived";
  const locked = privileged && guessable;

  useEffect(() => { emit.current(password); }, [password]);
  useEffect(() => { if (locked && !mustChange) onMustChange(true); }, [locked, mustChange, onMustChange]);

  function choose(next: PasswordMethod) {
    setMethod(next);
    setCopied(false);
    if (next === "random") setRandom(generateRandomPassword());
  }
  async function copy() {
    try { await navigator.clipboard.writeText(random); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <Stack gap={1}>
      <FormControl>
        <FormLabel id="pw-method">رمز موقت <HelpHint label="راهنمای روش‌های رمز موقت">{HELP}</HelpHint></FormLabel>
        <RadioGroup aria-labelledby="pw-method" value={method} onChange={(e) => choose(e.target.value as PasswordMethod)}>
          <FormControlLabel value="random" control={<Radio />} label="تصادفی" />
          <FormControlLabel value="mobile" control={<Radio />} disabled={mobileValue === null} label="شمارهٔ موبایل" />
          <FormControlLabel value="derived" control={<Radio />} disabled={derivedValue === null} label="مشتق از موبایل و کد پرسنلی" />
          <FormControlLabel value="manual" control={<Radio />} label="تایپ دستی" />
        </RadioGroup>
        {method === "none" && <Typography variant="caption" color="text.secondary">یکی از روش‌ها را انتخاب کنید.</Typography>}
        {(mobileValue === null || derivedValue === null) && (
          <Typography variant="caption" color="text.secondary">
            {mobileValue === null ? "روش موبایل بدون شمارهٔ معتبر در دسترس نیست." : "روش مشتق بدون کد پرسنلی معتبر در دسترس نیست."}
          </Typography>
        )}
      </FormControl>
      {method === "random" && (
        <Stack direction="row" gap={1} alignItems="center">
          <TextField label="رمز تولیدشده" value={random} slotProps={{ htmlInput: { readOnly: true, dir: "ltr" } }} sx={{ flex: 1 }} />
          <Button onClick={copy}>{copied ? "کپی شد" : "کپی"}</Button>
          <Button onClick={() => { setRandom(generateRandomPassword()); setCopied(false); }}>رمز دیگر</Button>
        </Stack>
      )}
      {method === "manual" && (
        <TextField label="رمز عبور موقت" type="text" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" slotProps={{ htmlInput: { dir: "ltr" } }} />
      )}
      {guessable && password && <Typography variant="caption" dir="ltr" component="div" sx={{ textAlign: "start" }}>{password}</Typography>}
      <FormControlLabel
        control={<Switch checked={mustChange || locked} disabled={locked} onChange={(e) => onMustChange(e.target.checked)} />}
        label="کاربر در اولین ورود باید رمز را تغییر دهد"
      />
      {locked && <Alert severity="warning">رمز موبایلی یا مشتق از آن قابل حدس است؛ برای حساب مدیر و بازرس تغییر رمز در اولین ورود الزامی است.</Alert>}
    </Stack>
  );
}
