import { ApiError } from "../api/http";
import { toPersianDigits } from "../lib/dates";

/** Persian texts for the stable error codes the backend returns (docs/management-api.md, docs/auth.md). */
const MESSAGES: Record<string, string> = {
  network_error: "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.",
  invalid_credentials: "نام کاربری یا رمز عبور نادرست است.",
  not_authenticated: "نشست شما پایان یافته است. دوباره وارد شوید.",
  forbidden: "شما اجازهٔ انجام این کار را ندارید.",
  password_change_required: "ابتدا باید رمز عبور خود را تغییر دهید.",
  csrf_check_failed: "درخواست نامعتبر است. صفحه را دوباره باز کنید.",
  validation_error: "اطلاعات واردشده معتبر نیست.",
  username_taken: "این نام کاربری قبلاً ثبت شده است.",
  invalid_username: "نام کاربری باید ۳ تا ۶۴ نویسه و فقط شامل حروف انگلیسی، عدد و . _ - باشد.",
  invalid_full_name: "نام کامل باید بین ۱ تا ۱۲۸ نویسه باشد.",
  invalid_name: "نام باید بین ۱ تا ۱۲۸ نویسه باشد.",
  invalid_description: "توضیحات حداکثر ۲۰۰۰ نویسه می‌تواند باشد.",
  unknown_role: "نقش انتخاب‌شده معتبر نیست.",
  user_not_found: "کاربر پیدا نشد.",
  cannot_deactivate_self: "نمی‌توانید حساب خودتان را غیرفعال کنید.",
  cannot_change_own_role: "نمی‌توانید نقش خودتان را تغییر دهید.",
  use_change_password_endpoint: "رمز خودتان را از بخش «تغییر رمز عبور» عوض کنید.",
  last_management: "دست‌کم یک مدیر فعال باید باقی بماند.",
  group_not_found: "گروه پیدا نشد.",
  group_inactive: "این گروه غیرفعال است.",
  group_code_taken: "این کد گروه قبلاً ثبت شده است.",
  invalid_group_code: "کد گروه باید ۲ تا ۱۶ نویسه، با حرف انگلیسی شروع شود و فقط حروف و عدد داشته باشد.",
  equipment_not_found: "تجهیز پیدا نشد.",
  equipment_code_taken: "این کد تجهیز قبلاً ثبت شده است (حروف بزرگ و کوچک یکسان‌اند).",
  invalid_equipment_code: "کد تجهیز فقط می‌تواند شامل حروف انگلیسی، عدد و - . _ / باشد و فاصله نداشته باشد.",
  same_group: "تجهیز از قبل در همین گروه است.",
  report_type_not_found: "نوع گزارش پیدا نشد.",
  report_type_code_taken: "این کد نوع گزارش قبلاً ثبت شده است.",
  invalid_report_type_code: "کد نوع گزارش باید با حرف انگلیسی شروع شود و فقط حروف، عدد و _ داشته باشد.",
  report_type_in_use: "برای این نوع گزارش، گزارش ثبت شده است؛ «خرابی بودن» آن دیگر قابل تغییر نیست.",
  setting_not_found: "تنظیم پیدا نشد.",
  // --- report entry
  equipment_inactive: "این تجهیز غیرفعال است.",
  report_type_inactive: "این نوع گزارش غیرفعال است.",
  equipment_required: "برای این نوع گزارش، انتخاب تجهیز الزامی است.",
  group_required: "گروه را انتخاب کنید.",
  group_mismatch: "گروه انتخاب‌شده با گروه تجهیز یکی نیست.",
  equipment_or_group_required: "تجهیز یا گروه باید مشخص باشد.",
  event_in_future: "زمان رویداد نمی‌تواند در آینده باشد.",
  labor_required: "برای این نوع گزارش باید حداقل یک نفر با ساعت کار ثبت شود.",
  labor_not_allowed: "این نوع گزارش ساعت کار ندارد.",
  participant_duplicate: "یک نفر فقط یک بار می‌تواند در فهرست ساعت‌ها باشد.",
  participant_not_allowed: "برخی از افراد فهرست اجازهٔ ثبت در این گزارش را ندارند.",
  draft_not_found: "پیش‌نویس پیدا نشد؛ ممکن است قبلاً ثبت یا حذف شده باشد.",
  draft_limit_reached: "به حداکثر تعداد پیش‌نویس رسیده‌اید.",
  draft_version_conflict: "این پیش‌نویس در جای دیگری (تب یا دستگاه دیگر) تغییر کرده است.",
  report_number_conflict: "شمارهٔ گزارش تکراری شد. دوباره تلاش کنید.",
  invalid_labor_mode: "حالت ساعت کار معتبر نیست.",
  invalid_equipment_required: "مقدار «تجهیز الزامی» معتبر نیست.",
  // --- equipment import (file level)
  unsupported_file_type: "فقط فایل ‎.xlsx‎ یا ‎.csv‎ پذیرفته می‌شود.",
  file_too_large: "حجم فایل از حد مجاز بیشتر است.",
  length_required: "ارسال فایل ناقص بود. دوباره تلاش کنید.",
  file_corrupt: "فایل خراب است یا قابل خواندن نیست.",
  file_unsafe: "فایل ناایمن است (ماکرو یا ساختار مشکوک) و پذیرفته نشد.",
  file_encoding: "رمزگذاری فایل CSV پشتیبانی نمی‌شود؛ آن را با گزینهٔ «CSV UTF-8» ذخیره کنید.",
  empty_file: "فایل خالی است.",
  no_data_rows: "فایل هیچ ردیف داده‌ای ندارد (فقط سرستون دارد).",
  multiple_sheets: "فایل باید فقط یک برگه (Sheet) داشته باشد.",
  duplicate_columns: "یکی از ستون‌های استاندارد در سرستون تکرار شده است.",
  nothing_to_import: "هیچ ردیف معتبری برای ورود وجود ندارد.",
  file_changed: "فایل با فایل بررسی‌شده یکسان نیست. دوباره بررسی کنید.",
  import_conflict: "هم‌زمان با ورود، کد تکراری ثبت شد. فایل را دوباره بررسی کنید.",
  import_batch_not_found: "ورود گروهی پیدا نشد.",
  batch_already_undone: "این ورود گروهی قبلاً لغو شده است.",
  batch_empty: "تجهیزی برای لغو باقی نمانده است.",
  batch_equipment_moved: "برخی از تجهیزات این ورود به گروه دیگری منتقل شده‌اند؛ لغو ممکن نیست.",
};

const PASSWORD_ERRORS: Record<string, string> = {
  too_short: "رمز عبور کوتاه‌تر از حد مجاز است.",
  too_long: "رمز عبور بیش از حد طولانی است.",
  too_common: "این رمز عبور بسیار رایج است؛ رمز دیگری انتخاب کنید.",
  too_simple: "رمز عبور خیلی ساده است (مثلاً اعداد پشت‌سرهم یا نویسهٔ تکراری).",
  same_as_username: "رمز عبور نباید با نام کاربری یکسان باشد.",
  same_as_current: "رمز جدید باید با رمز فعلی متفاوت باشد.",
};

export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "خطای پیش‌بینی‌نشده رخ داد.";
  const d = err.detail;
  switch (err.code) {
    case "too_many_attempts":
      return err.retryAfter
        ? `تعداد تلاش‌های ناموفق زیاد است. حدود ${toPersianDigits(String(Math.ceil(err.retryAfter / 60)))} دقیقه بعد دوباره تلاش کنید.`
        : "تعداد تلاش‌های ناموفق زیاد است. کمی بعد دوباره تلاش کنید.";
    case "password_policy": {
      const list = Array.isArray(d.errors) ? (d.errors as string[]) : [];
      return list.map((c) => PASSWORD_ERRORS[c] ?? c).join(" ") || "رمز عبور پذیرفته نشد.";
    }
    case "too_many_rows":
      return `تعداد ردیف‌های فایل از حد مجاز (${toPersianDigits(String(d.max_rows))} ردیف) بیشتر است. فایل را به چند بخش تقسیم کنید.`;
    case "missing_columns": {
      const cols = Array.isArray(d.columns) ? (d.columns as string[]).join("، ") : "";
      return `ستون‌های ضروری در سرستون ردیف اول پیدا نشد: ${cols}`;
    }
    case "batch_has_reports": {
      const codes = Array.isArray(d.equipment_codes) ? ` (${(d.equipment_codes as string[]).slice(0, 5).join("، ")})` : "";
      return d.report_count
        ? `برای تجهیزات این ورود ${toPersianDigits(String(d.report_count))} گزارش ثبت شده است${codes}؛ لغو ممکن نیست.`
        : "برای تجهیزات این ورود گزارش ثبت شده است؛ لغو ممکن نیست.";
    }
    case "invalid_description":
      return d.max_length ? `توضیحات باید بین ۱ تا ${toPersianDigits(String(d.max_length))} نویسه باشد.` : MESSAGES.invalid_description;
    case "participant_not_allowed":
      return MESSAGES.participant_not_allowed;
    case "draft_limit_reached":
      return d.limit ? `حداکثر ${toPersianDigits(String(d.limit))} پیش‌نویس می‌توانید داشته باشید.` : MESSAGES.draft_limit_reached;
    case "group_has_active_equipment":
      return `این گروه ${toPersianDigits(String(d.count))} تجهیز فعال دارد. ابتدا تجهیزات را منتقل یا غیرفعال کنید.`;
    case "setting_out_of_range": {
      const special = Array.isArray(d.special) && d.special.length ? ` یا ${(d.special as number[]).map((n) => toPersianDigits(String(n))).join("، ")}` : "";
      return `مقدار باید بین ${toPersianDigits(String(d.minimum))} و ${toPersianDigits(String(d.maximum))}${special} باشد.`;
    }
    default:
      return MESSAGES[err.code] ?? `خطا (${err.code})`;
  }
}
