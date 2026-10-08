// Run every test in a NON-Tehran, non-UTC browser timezone so any accidental use of "local time" shows up as a failure.
export default function setup() {
  process.env.TZ = "America/Los_Angeles";
}
