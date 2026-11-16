import PhoneViewer from "../../../components/PhoneViewer";

export default async function PhonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PhoneViewer id={id} />;
}
