alter table public.empleados
  add column if not exists email text;

create unique index if not exists empleados_email_unique
  on public.empleados (lower(email))
  where email is not null;
