// src/fulfillment-view.jsx
//
// Fulfillment queue for all 3 Etsy shops.
//
// Data source (when Rust layer is ready):
//   invoke("get_orders") -> Order[]
//
// Etsy field mapping notes for src-tauri/src/etsy.rs:
//   order.shipped     <- receipt.status === "completed"
//   order.received_date <- receipt.create_timestamp (Unix -> ISO date)
//   order.due_date    <- receipt.expected_ship_date (Unix -> ISO date)
//   order.buyer       <- receipt.name
//   order.note        <- receipt.message_from_buyer (null if empty)
//   order.finish      <- receipt.transactions[0].variations[name="Finish"].value
//   order.material    <- receipt.transactions[0].variations[name="Material"].value
//   order.hanging_holes <- receipt.transactions[0].personalization (parse int from string)
//
// "postage printed = completed" — no manual toggle. This view is read-only
// for shipping status; it comes directly from Etsy receipt.status.

import React, { useState, useMemo } from "react";
import "./fulfillment-view.css";

// ── Mock data ─────────────────────────────────────────────────────────────────
// Replace with: const [orders, setOrders] = useState([]);
// then on mount:  invoke("get_orders").then(setOrders);

const MOCK_ORDERS = [
  {
    id: "3781024956",
    product: "Laser Cut Mandala Wall Art",
    buyer: "Sarah M.",
    finish: "Natural",
    material: "Birch",
    hanging_holes: 2,
    due_date: "2026-05-24",
    note: "Please add extra padding — it's a birthday gift, needs to arrive perfect",
    shipped: false,
    received_date: "2026-05-17",
  },
  {
    id: "3781103847",
    product: "Custom Name Sign — Script",
    buyer: "James R.",
    finish: "Stained Walnut",
    material: "MDF",
    hanging_holes: 0,
    due_date: "2026-05-26",
    note: null,
    shipped: false,
    received_date: "2026-05-19",
  },
  {
    id: "3780998231",
    product: "Geometric Shelf Bracket Pair",
    buyer: "Priya K.",
    finish: "Black",
    material: "Birch",
    hanging_holes: 4,
    due_date: "2026-05-28",
    note: "Hang holes need to be 3/16\" — standard won't fit my wall anchors",
    shipped: false,
    received_date: "2026-05-21",
  },
  {
    id: "3780874412",
    product: "State Outline Cut-Out — Texas",
    buyer: "Linda H.",
    finish: "Natural",
    material: "Birch",
    hanging_holes: 1,
    due_date: "2026-05-30",
    note: null,
    shipped: false,
    received_date: "2026-05-22",
  },
  {
    id: "3780756389",
    product: "Laser Cut Mandala Wall Art",
    buyer: "Tom W.",
    finish: "Stained Walnut",
    material: "Birch",
    hanging_holes: 2,
    due_date: "2026-05-19",
    note: null,
    shipped: true,
    received_date: "2026-05-12",
  },
  {
    id: "3780621047",
    product: "Custom Wedding Date Sign",
    buyer: "Ashley D.",
    finish: "White",
    material: "MDF",
    hanging_holes: 2,
    due_date: "2026-06-02",
    note: null,
    shipped: false,
    received_date: "2026-05-24",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDue(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dueDaysFrom(iso, today) {
  return Math.round((parseDue(iso) - today) / 86400000);
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function dueBadgeClass(order, today) {
  if (order.shipped) return "due-shipped";
  const days = dueDaysFrom(order.due_date, today);
  if (days < 0) return "due-overdue";
  if (days <= 1) return "due-soon";
  return "due-normal";
}

function dueBadgeText(order, today) {
  if (order.shipped) return "Shipped";
  const days = dueDaysFrom(order.due_date, today);
  const label = formatDate(order.due_date);
  if (days < 0) return `Overdue · ${label}`;
  if (days === 0) return `Due today`;
  if (days === 1) return `Due tomorrow`;
  return `Due ${label}`;
}

// ── Filter logic ──────────────────────────────────────────────────────────────

const FILTERS = ["All", "Open", "Overdue", "Notes", "Shipped"];

function filterOrders(orders, filter, today) {
  switch (filter) {
    case "Open":    return orders.filter(o => !o.shipped);
    case "Overdue": return orders.filter(o => !o.shipped && dueDaysFrom(o.due_date, today) < 0);
    case "Notes":   return orders.filter(o => o.note);
    case "Shipped": return orders.filter(o => o.shipped);
    default:        return orders;
  }
}

function countFor(filter, orders, today) {
  return filterOrders(orders, filter, today).length;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FulfillmentView() {
  const [activeFilter, setActiveFilter] = useState("All");
  const [expandedId, setExpandedId] = useState(null);

  const today = useMemo(() => getToday(), []);

  const visible = useMemo(() => {
    const filtered = filterOrders(MOCK_ORDERS, activeFilter, today);
    return [...filtered].sort((a, b) => parseDue(a.due_date) - parseDue(b.due_date));
  }, [activeFilter, today]);

  function toggleExpand(id) {
    setExpandedId(prev => (prev === id ? null : id));
  }

  return (
    <div className="fulfillment-view">
      <div className="filter-bar">
        {FILTERS.map(f => {
          const count = countFor(f, MOCK_ORDERS, today);
          return (
            <button
              key={f}
              className={[
                "pill",
                activeFilter === f ? "active" : "",
                f === "Overdue" ? "filter-overdue" : "",
                f === "Notes"   ? "filter-notes"   : "",
              ].join(" ").trim()}
              onClick={() => setActiveFilter(f)}
            >
              {f}
              <span className="pill-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="orders-list">
        {visible.length === 0 && (
          <div className="empty-state">No orders in this filter.</div>
        )}
        {visible.map(order => {
          const expanded = expandedId === order.id;
          return (
            <div
              key={order.id}
              className={`order-card${expanded ? " expanded" : ""}`}
              onClick={() => toggleExpand(order.id)}
            >
              <div className="order-row">
                {/* Left: product name, order ID, buyer */}
                <div className="order-left">
                  <div className="order-primary">
                    <span className="order-product">{order.product}</span>
                    {order.note && <span className="note-badge">NOTE</span>}
                  </div>
                  <div className="order-secondary">
                    <span className="order-id">#{order.id}</span>
                    <span>{order.buyer}</span>
                  </div>
                </div>

                {/* Finish / material */}
                <div className="order-finish">
                  {order.finish} / {order.material}
                </div>

                {/* Due date */}
                <span className={`due-badge ${dueBadgeClass(order, today)}`}>
                  {dueBadgeText(order, today)}
                </span>

                {/* Postage */}
                <div className="postage-status">
                  <span className={`postage-dot ${order.shipped ? "shipped" : "pending"}`} />
                  {order.shipped ? "Shipped" : "Not shipped"}
                </div>
              </div>

              {expanded && (
                <div
                  className="order-detail"
                  onClick={e => e.stopPropagation()}
                >
                  <div className="detail-item">
                    <span className="detail-label">Received</span>
                    <span className="detail-value">{formatDate(order.received_date)}, {order.received_date.slice(0, 4)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Hanging holes</span>
                    <span className="detail-value">{order.hanging_holes === 0 ? "None" : order.hanging_holes}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Finish / Material</span>
                    <span className="detail-value">{order.finish} / {order.material}</span>
                  </div>
                  {order.note && (
                    <div className="detail-item detail-note">
                      <span className="detail-label">Special instructions</span>
                      <div className="note-text">{order.note}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
