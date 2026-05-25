import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_TYPES, type ChartConfig, type QueryResult } from "../types";

export function ChartPanel({
  config,
  result,
  onChange,
  onClose,
}: {
  config: ChartConfig;
  result: QueryResult;
  onChange: (cfg: ChartConfig) => void;
  onClose: () => void;
}) {
  const columnNames = result.columns.map((c) => c.name);

  const data = useMemo(() => {
    return result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((c, i) => {
        const v = row[i];
        if (typeof v === "string") {
          const n = Number(v);
          obj[c.name] = !Number.isNaN(n) && v.trim() !== "" ? n : v;
        } else {
          obj[c.name] = v;
        }
      });
      return obj;
    });
  }, [result]);

  const setField = (field: keyof ChartConfig, value: string) =>
    onChange({ ...config, [field]: value });

  const x = config.x_axis;
  const y = config.y_axis;
  const palette = ["#1e7e34", "#1677ff", "#fa8c16", "#a8071a", "#722ed1", "#13c2c2"];

  let chart: React.ReactNode = null;
  if (config.type === "bar") {
    chart = (
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={x} />
        <YAxis />
        <Tooltip />
        <Legend />
        <Bar dataKey={y} fill={palette[0]} />
      </BarChart>
    );
  } else if (config.type === "line") {
    chart = (
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={x} />
        <YAxis />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey={y} stroke={palette[0]} dot={false} />
      </LineChart>
    );
  } else if (config.type === "area") {
    chart = (
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={x} />
        <YAxis />
        <Tooltip />
        <Legend />
        <Area type="monotone" dataKey={y} stroke={palette[0]} fill={palette[0]} fillOpacity={0.3} />
      </AreaChart>
    );
  } else if (config.type === "scatter") {
    chart = (
      <ScatterChart>
        <CartesianGrid />
        <XAxis dataKey={x} type="number" name={x} />
        <YAxis dataKey={y} type="number" name={y} />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} />
        <Scatter data={data} fill={palette[0]} />
      </ScatterChart>
    );
  } else if (config.type === "pie") {
    chart = (
      <PieChart>
        <Tooltip />
        <Pie data={data} dataKey={y} nameKey={x} label outerRadius={120}>
          {data.map((_, i) => (
            <Cell key={i} fill={palette[i % palette.length]} />
          ))}
        </Pie>
      </PieChart>
    );
  }

  return (
    <div
      style={{
        border: "1px solid #cfe1ff",
        background: "#f4f8ff",
        borderRadius: 4,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>📊 {config.title || "Chart"}</strong>
        <span style={{ marginLeft: 4 }}>Type:</span>
        <select value={config.type} onChange={(e) => setField("type", e.target.value)}>
          {CHART_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span>X:</span>
        <select value={config.x_axis} onChange={(e) => setField("x_axis", e.target.value)}>
          {columnNames.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span>Y:</span>
        <select value={config.y_axis} onChange={(e) => setField("y_axis", e.target.value)}>
          {columnNames.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button onClick={onClose} style={{ marginLeft: "auto" }}>
          Close
        </button>
      </div>
      {config.reasoning && (
        <div style={{ fontSize: 11, color: "#666" }}>{config.reasoning}</div>
      )}
      <div style={{ width: "100%", height: 360, background: "white", borderRadius: 4 }}>
        {chart && (
          <ResponsiveContainer width="100%" height="100%">
            {chart as React.ReactElement}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
