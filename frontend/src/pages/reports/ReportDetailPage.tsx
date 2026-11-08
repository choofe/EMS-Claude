import { Alert, Button, Chip, Divider, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import LockIcon from "@mui/icons-material/LockOutlined";
import { Link as RouterLink, useParams } from "react-router-dom";
import { reportsApi } from "../../api/resources";
import { ErrorAlert, Loading, Ltr, PageHeader } from "../../components/common";
import { formatJalaliDateTime } from "../../lib/dates";
import { formatMinutes } from "../../lib/labor";
import { useLoad } from "../../lib/useLoad";
import { GeneralChip } from "./ReportsListPage";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Stack direction="row" gap={1} sx={{ py: 0.5 }}><Typography color="text.secondary" sx={{ minWidth: 110 }}>{label}</Typography><Typography component="div">{children}</Typography></Stack>
);

export function ReportDetailPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const { data, error, loading } = useLoad(() => (valid ? reportsApi.detail(id) : Promise.reject(new Error("bad id"))), [id]);

  const r = data && data.id === id ? data : null; // never show the previous report under a new URL
  const back = <Button component={RouterLink} to="/reports">بازگشت به فهرست</Button>;
  if (!valid) return <><PageHeader title="گزارش" actions={back} /><Alert severity="error">گزارش پیدا نشد یا اجازهٔ دیدن آن را ندارید.</Alert></>;
  if (loading) return <Loading />;
  if (!r) return <><PageHeader title="گزارش" actions={back} /><ErrorAlert error={error} /></>;

  return (
    <>
      <PageHeader title={`گزارش ${r.report_number}`} actions={back} />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>
          {r.is_general && <GeneralChip />}
          {r.report_type.is_failure && <Chip size="small" color="warning" label="خرابی" />}
          {r.is_locked && <Chip size="small" icon={<LockIcon />} label={`قفل‌شده ${formatJalaliDateTime(r.locked_at)}`} />}
        </Stack>
        <Field label="شمارهٔ گزارش"><Ltr>{r.report_number}</Ltr></Field>
        <Field label="نوع گزارش">{r.report_type.name_fa}</Field>
        <Field label="گروه">{r.group.name} (<Ltr>{r.group.code}</Ltr>)</Field>
        <Field label="تجهیز">{r.equipment ? <Button component={RouterLink} to={`/reports?equipment_id=${r.equipment.id}&equipment=${encodeURIComponent(r.equipment.code)}`} size="small" sx={{ minWidth: 0 }}><Ltr>{r.equipment.code}</Ltr></Button> : "—"}</Field>
        <Field label="زمان رخداد">{formatJalaliDateTime(r.event_datetime)}</Field>
        <Field label="زمان ثبت">{formatJalaliDateTime(r.created_at)}</Field>
        <Field label="ثبت‌کننده">{r.creator.full_name}</Field>
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="subtitle2" gutterBottom>شرح</Typography>
        <Typography sx={{ whiteSpace: "pre-wrap" }}>{r.description}</Typography>
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="subtitle2" gutterBottom>افراد و زمان کار</Typography>
        {!r.participants_complete && (
          <Alert severity="info" sx={{ mb: 1 }}>{r.participants.length ? "فقط ردیف مربوط به خودتان نمایش داده می‌شود." : "اطلاعات زمان کار افراد برای شما نمایش داده نمی‌شود."}</Alert>
        )}
        {r.participants.length > 0 && (
          <Table size="small">
            <TableHead><TableRow><TableCell>نام</TableCell><TableCell>زمان کار</TableCell></TableRow></TableHead>
            <TableBody>
              {r.participants.map((p) => <TableRow key={p.user_id}><TableCell>{p.full_name}{p.is_me ? " (شما)" : ""}</TableCell><TableCell>{formatMinutes(p.minutes)}</TableCell></TableRow>)}
            </TableBody>
          </Table>
        )}
        {r.participants_complete && r.participants.length === 0 && <Typography color="text.secondary">زمان کاری ثبت نشده است.</Typography>}
      </Paper>
    </>
  );
}
