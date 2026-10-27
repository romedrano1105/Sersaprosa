"use client";

import { useEffect, useRef, useState } from "react";
import { CircleDot, MapPin, Plus, Trash2 } from "lucide-react";

export type RouteLocation = {
  id: string;
  type: "origin" | "stop" | "destination";
  value: string;
};

type RouteStopsInputProps = {
  onLocationsChange?: (locations: RouteLocation[]) => void;
};

const initialLocations: RouteLocation[] = [
  { id: "origin", type: "origin", value: "" },
  { id: "destination", type: "destination", value: "" },
];

export default function RouteStopsInput({
  onLocationsChange,
}: RouteStopsInputProps) {
  const [locations, setLocations] = useState<RouteLocation[]>(initialLocations);
  const nextStopId = useRef(1);

  useEffect(() => {
    onLocationsChange?.(locations);
  }, [locations, onLocationsChange]);

  function updateLocation(id: string, value: string) {
    setLocations((current) =>
      current.map((location) =>
        location.id === id ? { ...location, value } : location,
      ),
    );
  }

  function addStop() {
    const stop: RouteLocation = {
      id: `stop-${nextStopId.current++}`,
      type: "stop",
      value: "",
    };

    setLocations((current) => [
      ...current.slice(0, -1),
      stop,
      current[current.length - 1],
    ]);
  }

  function removeStop(id: string) {
    setLocations((current) =>
      current.filter((location) => location.id !== id),
    );
  }

  return (
    <section className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="mb-6">
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">
          Planificación de ruta
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
          ¿A dónde vamos?
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Define el origen, las paradas y el destino de tu recorrido.
        </p>
      </div>

      <ol className="space-y-3" aria-label="Ubicaciones de la ruta">
        {locations.map((location, index) => {
          const isOrigin = location.type === "origin";
          const isDestination = location.type === "destination";
          const label = isOrigin
            ? "Punto de origen"
            : isDestination
              ? "Destino final"
              : `Parada ${locations
                  .slice(1, index)
                  .filter((item) => item.type === "stop").length + 1}`;

          return (
            <li
              key={location.id}
              className="flex min-w-0 items-center gap-3"
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                  isOrigin
                    ? "bg-emerald-50 text-emerald-700"
                    : isDestination
                      ? "bg-rose-50 text-rose-700"
                      : "bg-blue-50 text-blue-700"
                }`}
                aria-hidden="true"
              >
                {isOrigin ? (
                  <CircleDot size={19} />
                ) : (
                  <MapPin size={19} />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`route-location-${location.id}`}
                  className="mb-1 block text-xs font-medium text-slate-600"
                >
                  {label}
                </label>
                <input
                  id={`route-location-${location.id}`}
                  type="text"
                  value={location.value}
                  onChange={(event) =>
                    updateLocation(location.id, event.target.value)
                  }
                  placeholder={
                    isOrigin
                      ? "Ingresa el punto de partida"
                      : isDestination
                        ? "Ingresa el destino final"
                        : "Ingresa una dirección o lugar"
                  }
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                />
                {/* Conectar aquí Google Maps Places Autocomplete u otro proveedor de mapas. */}
              </div>

              {location.type === "stop" && (
                <button
                  type="button"
                  onClick={() => removeStop(location.id)}
                  aria-label={`Eliminar ${label.toLowerCase()}`}
                  title="Eliminar parada"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-100"
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={addStop}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-300 px-4 py-2.5 text-sm font-semibold text-blue-700 transition hover:border-blue-500 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-100 sm:w-auto"
      >
        <Plus size={18} aria-hidden="true" />
        Agregar parada
      </button>
    </section>
  );
}
