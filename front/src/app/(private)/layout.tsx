export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  // The session guard lands here in TRE-15: no server session redirects to
  // /login before anything renders.
  return <>{children}</>;
}
