-- Perfil operativo de empleados. No guarda contraseñas; la autenticación vive en Supabase Auth.
create table if not exists public.empleados (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  nombre text not null,
  correo text unique,
  email text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  licencia date,
  categoria text
);

alter table public.empleados
  add column if not exists codigo text,
  add column if not exists nombre text,
  add column if not exists correo text,
  add column if not exists email text,
  add column if not exists activo boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists licencia date,
  add column if not exists categoria text;

create unique index if not exists empleados_email_unique
  on public.empleados (lower(email))
  where email is not null;
