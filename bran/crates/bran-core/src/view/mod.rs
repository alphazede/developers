//! Deterministic, persistent Knowledge Views over an immutable graph.
//!
//! A [`ViewSpec`] is deliberately limited to durable selection and presentation
//! choices. Runtime packet assembly and compression are separate boundaries.

use crate::graph::{KnowledgeGraph, NodeId, NodeRole, Provenance};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

/// Declarative source selection for a persistent knowledge view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewSource {
    All,
    NodeIds(Vec<NodeId>),
    Roles(Vec<NodeRole>),
    ProvenanceSourceContains(String),
}

/// Deterministic predicates applied after source selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewFilter {
    All,
    Role(NodeRole),
    IdPrefix(String),
    ProvenanceSourceContains(String),
    ProvenanceLocatorContains(String),
    MinimumConfidence(u8),
    AllOf(Vec<ViewFilter>),
    AnyOf(Vec<ViewFilter>),
    Not(Box<ViewFilter>),
}

/// Stable ordering modes. Every mode breaks ties by stable node identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ViewSort {
    NodeId,
    RoleThenNodeId,
    ProvenanceSourceThenNodeId,
    ConfidenceDescendingThenNodeId,
}

/// The group layout of a compiled view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ViewGrouping {
    None,
    Role,
    ProvenanceSource,
}

/// Fields copied from graph nodes into a compiled view item.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ViewField {
    NodeId,
    Role,
    ProvenanceSource,
    ProvenanceLocator,
    Confidence,
}

/// A renderer preference recorded with the view without changing selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Presentation {
    Markdown,
    Json,
    Terminal,
    Obsidian,
}

/// Persistent, dependency-free view declaration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewSpec {
    pub source: ViewSource,
    pub filter: ViewFilter,
    pub sort: ViewSort,
    pub grouping: ViewGrouping,
    pub fields: Vec<ViewField>,
    pub presentation: Presentation,
    pub max_items: usize,
    pub max_bytes: usize,
}

/// A projected field with its stable wire name and value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectedField {
    pub field: ViewField,
    pub name: &'static str,
    pub value: String,
}

/// One selected graph node, retaining its source evidence verbatim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewItem {
    pub id: NodeId,
    pub group: Option<String>,
    pub provenance: Provenance,
    pub fields: Vec<ProjectedField>,
    rendered_bytes: usize,
}

impl ViewItem {
    /// Returns the canonical byte contribution used by this view's byte limit.
    pub fn rendered_bytes(&self) -> usize {
        self.rendered_bytes
    }
}

/// Immutable grouped output shared by every renderer projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompiledView {
    spec: ViewSpec,
    items: Vec<ViewItem>,
    groups: BTreeMap<String, Vec<NodeId>>,
    selected_bytes: usize,
    truncated: bool,
}

impl CompiledView {
    pub fn spec(&self) -> &ViewSpec {
        &self.spec
    }

    pub fn items(&self) -> &[ViewItem] {
        &self.items
    }

    pub fn groups(&self) -> &BTreeMap<String, Vec<NodeId>> {
        &self.groups
    }

    pub fn selected_bytes(&self) -> usize {
        self.selected_bytes
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Projects the same already-selected item identities for a renderer.
    pub fn render_model(&self, presentation: Presentation) -> RenderModel {
        RenderModel {
            presentation,
            node_ids: self.items.iter().map(|item| item.id.clone()).collect(),
            items: self.items.clone(),
            groups: self.groups.clone(),
            selected_bytes: self.selected_bytes,
            truncated: self.truncated,
        }
    }

    /// Projects using the preference persisted by the view declaration.
    pub fn preferred_render_model(&self) -> RenderModel {
        self.render_model(self.spec.presentation)
    }
}

/// Renderer-neutral model derived only from one [`CompiledView`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderModel {
    pub presentation: Presentation,
    pub node_ids: Vec<NodeId>,
    pub items: Vec<ViewItem>,
    pub groups: BTreeMap<String, Vec<NodeId>>,
    pub selected_bytes: usize,
    pub truncated: bool,
}

/// Stateless compiler for deterministic graph views.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ViewCompiler;

impl ViewCompiler {
    pub fn new() -> Self {
        Self
    }

    /// Compiles selection, ordering, grouping, projection, and explicit bounds.
    ///
    /// Candidates are filtered before one stable `O(k log k)` sort. Group keys
    /// use a `BTreeMap`, so both group and item order are replayable.
    pub fn compile(&self, spec: &ViewSpec, graph: &KnowledgeGraph) -> CompiledView {
        let wanted_ids = match &spec.source {
            ViewSource::NodeIds(ids) => Some(ids.iter().cloned().collect::<BTreeSet<_>>()),
            _ => None,
        };
        let mut candidates = graph
            .node_ids()
            .into_iter()
            .filter_map(|id| graph.node(&id))
            .filter(|node| source_matches(&spec.source, wanted_ids.as_ref(), node))
            .filter(|node| filter_matches(&spec.filter, node))
            .collect::<Vec<_>>();
        stable_sort(&mut candidates, spec.sort);

        let mut grouped = BTreeMap::<String, Vec<_>>::new();
        for node in candidates {
            grouped
                .entry(group_key(spec.grouping, node))
                .or_default()
                .push(node);
        }

        let mut items = Vec::new();
        let mut groups = BTreeMap::new();
        let mut selected_bytes = 0usize;
        let mut truncated = false;
        'groups: for (key, nodes) in grouped {
            for node in nodes {
                let item = project_item(node, group_value(spec.grouping, &key), &spec.fields);
                let Some(total) = selected_bytes.checked_add(item.rendered_bytes()) else {
                    truncated = true;
                    break 'groups;
                };
                if items.len() == spec.max_items || total > spec.max_bytes {
                    truncated = true;
                    break 'groups;
                }
                groups
                    .entry(key.clone())
                    .or_insert_with(Vec::new)
                    .push(item.id.clone());
                selected_bytes = total;
                items.push(item);
            }
        }

        CompiledView {
            spec: spec.clone(),
            items,
            groups,
            selected_bytes,
            truncated,
        }
    }
}

fn source_matches(
    source: &ViewSource,
    wanted_ids: Option<&BTreeSet<NodeId>>,
    node: &crate::graph::NodeInput,
) -> bool {
    match source {
        ViewSource::All => true,
        ViewSource::NodeIds(_) => wanted_ids.is_some_and(|ids| ids.contains(node.id())),
        ViewSource::Roles(roles) => roles.contains(&node.role()),
        ViewSource::ProvenanceSourceContains(value) => node.provenance().source().contains(value),
    }
}

fn filter_matches(filter: &ViewFilter, node: &crate::graph::NodeInput) -> bool {
    match filter {
        ViewFilter::All => true,
        ViewFilter::Role(role) => node.role() == *role,
        ViewFilter::IdPrefix(value) => node.id().as_str().starts_with(value),
        ViewFilter::ProvenanceSourceContains(value) => node.provenance().source().contains(value),
        ViewFilter::ProvenanceLocatorContains(value) => node.provenance().locator().contains(value),
        ViewFilter::MinimumConfidence(value) => node.confidence().value() >= *value,
        ViewFilter::AllOf(filters) => filters.iter().all(|filter| filter_matches(filter, node)),
        ViewFilter::AnyOf(filters) => filters.iter().any(|filter| filter_matches(filter, node)),
        ViewFilter::Not(filter) => !filter_matches(filter, node),
    }
}

fn stable_sort(nodes: &mut [&crate::graph::NodeInput], sort: ViewSort) {
    match sort {
        ViewSort::NodeId => nodes.sort_by_key(|node| node.id().clone()),
        ViewSort::RoleThenNodeId => {
            nodes.sort_by_key(|node| (role_name(node.role()), node.id().clone()))
        }
        ViewSort::ProvenanceSourceThenNodeId => {
            nodes.sort_by_key(|node| (node.provenance().source().to_owned(), node.id().clone()))
        }
        ViewSort::ConfidenceDescendingThenNodeId => {
            nodes.sort_by_key(|node| (Reverse(node.confidence().value()), node.id().clone()))
        }
    }
}

fn group_key(grouping: ViewGrouping, node: &crate::graph::NodeInput) -> String {
    match grouping {
        ViewGrouping::None => String::new(),
        ViewGrouping::Role => role_name(node.role()).to_owned(),
        ViewGrouping::ProvenanceSource => node.provenance().source().to_owned(),
    }
}

fn group_value(grouping: ViewGrouping, key: &str) -> Option<String> {
    match grouping {
        ViewGrouping::None => None,
        ViewGrouping::Role | ViewGrouping::ProvenanceSource => Some(key.to_owned()),
    }
}

fn project_item(
    node: &crate::graph::NodeInput,
    group: Option<String>,
    fields: &[ViewField],
) -> ViewItem {
    let fields = fields
        .iter()
        .map(|field| ProjectedField {
            field: *field,
            name: field_name(*field),
            value: field_value(*field, node),
        })
        .collect::<Vec<_>>();
    let rendered_bytes =
        canonical_item_bytes(node.id(), group.as_deref(), node.provenance(), &fields);
    ViewItem {
        id: node.id().clone(),
        group,
        provenance: node.provenance().clone(),
        fields,
        rendered_bytes,
    }
}

fn canonical_item_bytes(
    id: &NodeId,
    group: Option<&str>,
    provenance: &Provenance,
    fields: &[ProjectedField],
) -> usize {
    let group_bytes = group.map_or(0, str::len);
    id.as_str().len()
        + group_bytes
        + provenance.source().len()
        + provenance.locator().len()
        + fields
            .iter()
            .map(|field| field.name.len() + field.value.len())
            .sum::<usize>()
}

fn field_name(field: ViewField) -> &'static str {
    match field {
        ViewField::NodeId => "node_id",
        ViewField::Role => "role",
        ViewField::ProvenanceSource => "provenance_source",
        ViewField::ProvenanceLocator => "provenance_locator",
        ViewField::Confidence => "confidence",
    }
}

fn field_value(field: ViewField, node: &crate::graph::NodeInput) -> String {
    match field {
        ViewField::NodeId => node.id().as_str().to_owned(),
        ViewField::Role => role_name(node.role()).to_owned(),
        ViewField::ProvenanceSource => node.provenance().source().to_owned(),
        ViewField::ProvenanceLocator => node.provenance().locator().to_owned(),
        ViewField::Confidence => node.confidence().value().to_string(),
    }
}

fn role_name(role: NodeRole) -> &'static str {
    match role {
        NodeRole::Document => "document",
        NodeRole::Section => "section",
        NodeRole::Symbol => "symbol",
        NodeRole::External => "external",
        NodeRole::Entrypoint => "entrypoint",
        NodeRole::Test => "test",
        NodeRole::Generated => "generated",
        NodeRole::Archived => "archived",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Confidence, GraphInput, GraphLimits, NodeInput};

    #[test]
    fn p2_view() {
        let graph = KnowledgeGraph::build(
            GraphInput::new(
                vec![
                    NodeInput::new(
                        NodeId::parse("node.alpha").unwrap(),
                        NodeRole::Document,
                        Provenance::new("docs", "README.md").unwrap(),
                        Confidence::new(80).unwrap(),
                    ),
                    NodeInput::new(
                        NodeId::parse("node.beta").unwrap(),
                        NodeRole::Document,
                        Provenance::new("docs", "guide.md").unwrap(),
                        Confidence::new(80).unwrap(),
                    ),
                    NodeInput::new(
                        NodeId::parse("node.gamma").unwrap(),
                        NodeRole::Symbol,
                        Provenance::new("code", "src/lib.rs").unwrap(),
                        Confidence::new(95).unwrap(),
                    ),
                ],
                vec![],
            ),
            GraphLimits::new(3, 1).unwrap(),
        )
        .unwrap();
        let spec = ViewSpec {
            source: ViewSource::Roles(vec![NodeRole::Document]),
            filter: ViewFilter::AllOf(vec![
                ViewFilter::ProvenanceSourceContains("docs".to_owned()),
                ViewFilter::MinimumConfidence(80),
            ]),
            sort: ViewSort::ConfidenceDescendingThenNodeId,
            grouping: ViewGrouping::ProvenanceSource,
            fields: vec![ViewField::NodeId, ViewField::ProvenanceLocator],
            presentation: Presentation::Markdown,
            max_items: 2,
            max_bytes: 256,
        };
        let compiler = ViewCompiler::new();
        let compiled = compiler.compile(&spec, &graph);
        let replay = compiler.compile(&spec, &graph);
        let markdown = compiled.preferred_render_model();
        let json = compiled.render_model(Presentation::Json);
        let terminal = compiled.render_model(Presentation::Terminal);
        let item_bound = compiler.compile(
            &ViewSpec {
                max_items: 1,
                ..spec.clone()
            },
            &graph,
        );
        let byte_bound = compiler.compile(
            &ViewSpec {
                max_bytes: compiled.items()[0].rendered_bytes(),
                ..spec.clone()
            },
            &graph,
        );
        let zero_bound = compiler.compile(
            &ViewSpec {
                max_items: 0,
                ..spec
            },
            &graph,
        );

        assert_eq!(compiled.items().len(), 2);
        assert_eq!(compiled.items()[0].id.as_str(), "node.alpha");
        assert_eq!(compiled.items()[1].id.as_str(), "node.beta");
        assert_eq!(compiled.groups().get("docs").unwrap().len(), 2);
        assert_eq!(compiled.items()[0].fields[0].name, "node_id");
        assert_eq!(compiled.items()[0].fields[1].value, "README.md");
        assert_eq!(markdown.presentation, Presentation::Markdown);
        assert_eq!(markdown.node_ids, json.node_ids);
        assert_eq!(json.node_ids, terminal.node_ids);
        assert_eq!(compiled, replay);
        assert_eq!(item_bound.items().len(), 1);
        assert!(item_bound.truncated());
        assert_eq!(byte_bound.items().len(), 1);
        assert!(byte_bound.truncated());
        assert!(zero_bound.items().is_empty());
        assert!(zero_bound.truncated());
        assert!(compiled.selected_bytes() <= 256);
    }
}
